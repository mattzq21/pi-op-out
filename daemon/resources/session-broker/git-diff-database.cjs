const database = require('../session-database.cjs');

function open(root) {
  const db = database.open(root);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_diff_state (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_diff_records (
        session_id TEXT NOT NULL REFERENCES session_diff_state(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL, record_id TEXT NOT NULL, record_json TEXT NOT NULL, digest TEXT,
        PRIMARY KEY(session_id, kind, record_id));
      CREATE TABLE IF NOT EXISTS session_diff_locations (
        path TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_diff_state(session_id) ON DELETE CASCADE);`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function rootFor(filename, hooks) {
  try { return database.storageRoot(filename); }
  catch { return hooks.profile(); }
}

function identity(db, filename, hooks) {
  if (!filename.endsWith('.diffs.json')) return undefined;

  try { return hooks.owner(filename).toLowerCase(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;

    const row = db.prepare('SELECT session_id FROM session_diff_locations WHERE path=?').get(filename)
      ?? db.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(filename.replace(/\.diffs\.json$/, '.jsonl'));

    if (row) return row.session_id.toLowerCase();

    return undefined;
  }
}

function active(db, id) {
  if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=?').get(id)) throw new Error('Diff history session was deleted');
}

function initialize(db, filename, id, hooks) {
  if (db.prepare('SELECT 1 FROM session_diff_state WHERE session_id=?').get(id)) return;
  db.exec('BEGIN IMMEDIATE');

  try {
    active(db, id);

    if (!db.prepare('SELECT 1 FROM session_diff_state WHERE session_id=?').get(id)) {
      const state = hooks.legacy(filename);
      db.prepare('INSERT INTO session_diff_state VALUES (?, 1)').run(id);
      importState(db, id, state, hooks);
    }

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function importState(db, id, state, hooks) {
  for (const [message, snapshot] of Object.entries(state.snapshots)) put(db, id, 'set', message, snapshot, hooks.digest(snapshot));

  for (const [message, capture] of Object.entries(state.pending)) put(db, id, 'pending', message, capture);

  for (const [key, transfer] of Object.entries(state.transfers)) put(db, id, 'transfer', key, transfer);

  for (const message of state.done) put(db, id, 'done', message, true);
}

function put(db, id, kind, key, value, digest = null) {
  db.prepare(`INSERT INTO session_diff_records VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, kind, record_id) DO UPDATE SET record_json=excluded.record_json, digest=excluded.digest`)
    .run(id, kind, key, JSON.stringify(value), digest);
}

function load(filename, hooks, materialize, focus) {
  const root = rootFor(filename, hooks);
  const db = open(root);

  try {
    const id = identity(db, filename, hooks);

    if (!id) return hooks.unowned(filename, materialize, focus);
    active(db, id);
    initialize(db, filename, id, hooks);
    db.exec('BEGIN IMMEDIATE');
    active(db, id);
    db.prepare('INSERT INTO session_diff_locations VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id').run(filename, id);
    const state = readState(db, id, hooks, materialize, focus);
    db.exec('COMMIT');
    state.database = { root, id, revision: state.end };

    return state;
  } finally { db.close(); }
}

function readState(db, id, hooks, materialize, focus) {
  const state = hooks.empty();
  state.end = db.prepare('SELECT revision FROM session_diff_state WHERE session_id=?').get(id).revision;

  const rows = db.prepare(`SELECT kind, record_id, digest,
    CASE WHEN kind='set' AND ?=0 THEN NULL
      WHEN kind='pending' AND record_id<>? THEN json_remove(record_json, '$.snapshot')
      ELSE record_json END AS body FROM session_diff_records WHERE session_id=?`).all(materialize ? 1 : 0, focus ?? '', id);

  for (const row of rows) loadRecord(state, row);

  return state;
}

function loadRecord(state, row) {
  const id = row.record_id;

  if (row.kind === 'set') {
    state.digests[id] = row.digest; state.positions[id] = id;

    if (row.body !== null) state.snapshots[id] = JSON.parse(row.body);
  } else if (row.kind === 'pending') state.pending[id] = JSON.parse(row.body);
  else if (row.kind === 'transfer') state.transfers[id] = JSON.parse(row.body);
  else if (row.kind === 'done') state.done.add(id);
  else throw new Error('Unknown stored diff record');
}

function save(state, records, hooks) {
  if (!state.database) throw new Error('Diff history has no session identity');
  const { root, id, revision } = state.database;
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    active(db, id);
    const changed = db.prepare('UPDATE session_diff_state SET revision=revision+1 WHERE session_id=? AND revision=?').run(id, revision);

    if (changed.changes !== 1) throw new Error('Diff history changed while saving; retry the operation');

    for (const record of records) apply(db, id, record, hooks);
    db.exec('COMMIT');
  } finally { db.close(); }
}

function apply(db, id, record, hooks) {
  if (record.op === 'set') put(db, id, 'set', record.id, record.snapshot, hooks.digest(record.snapshot));
  else if (record.op === 'pending') put(db, id, 'pending', record.id, record.capture);
  else if (record.op === 'transfer') put(db, id, 'transfer', record.key, record.transfer);
  else if (record.op === 'remove') db.prepare("DELETE FROM session_diff_records WHERE session_id=? AND kind='set' AND record_id=?").run(id, record.id);
  else if (record.op === 'done') {
    db.prepare("DELETE FROM session_diff_records WHERE session_id=? AND kind='pending' AND record_id=?").run(id, record.id);
    put(db, id, 'done', record.id, true);
  } else throw new Error('Unknown diff database operation');
}

function snapshots(state, operation) {
  if (!state.database) return operation(() => { throw new Error('Diff snapshot is missing'); });
  const { root, id, revision } = state.database;
  const db = open(root);

  try {
    db.exec('BEGIN');
    active(db, id);

    if (db.prepare('SELECT revision FROM session_diff_state WHERE session_id=?').get(id)?.revision !== revision) throw new Error('Diff history changed while paging; retry from the first page');
    const query = db.prepare("SELECT record_json FROM session_diff_records WHERE session_id=? AND kind='set' AND record_id=?");

    return operation(message => {
      const row = query.get(id, message);

      if (!row) throw new Error('Diff snapshot is missing');

      return JSON.parse(row.record_json);
    });
  } finally { db.close(); }
}

module.exports = { load, save, snapshots };
