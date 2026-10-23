const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const database = require('../session-database.cjs');
const assets = require('./goal-assets.cjs');
const ownership = require('./goal-ownership.cjs');

function open(root) {
  const db = database.open(root);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS goal_directory_recoveries (directory TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS goal_directory_history (directory TEXT NOT NULL, previous_identity TEXT NOT NULL, current_identity TEXT NOT NULL, PRIMARY KEY(directory, previous_identity));`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function saved(db, directory) {
  const row = db.prepare('SELECT record_json FROM goal_directory_recoveries WHERE directory=?').get(directory);

  return row ? JSON.parse(row.record_json) : undefined;
}

function validate(root, directory, record) {
  if (!assets.validPath(root, directory) || !assets.validPath(root, record.staging) || path.dirname(record.staging) !== path.dirname(directory) || record.staging === directory) throw new Error('Invalid goal folder recovery');
}

function checkPreparation(db, directory, record) {
  const key = createHash('sha256').update(directory).digest('hex');

  if (db.prepare('SELECT 1 FROM goal_asset_reclamations WHERE record_id=?').get(key)) throw new Error('Goal folder deletion must finish before recovery');
  const row = db.prepare('SELECT record_json FROM goal_preparations WHERE directory=? AND identity=?').get(directory, record.previous);

  if (row?.record_json !== record.preparation) throw new Error('Saved goal preparation changed during recovery');
}

function moveRecords(db, directory, record) {
  checkPreparation(db, directory, record);

  for (const table of ['goal_preparations', 'goal_ownership', 'goal_asset_dependencies', 'goal_text_files', 'goal_text_contents']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    db.prepare(`UPDATE ${table} SET identity=? WHERE directory=? AND identity=?`).run(record.current, directory, record.previous);
  }

  db.prepare('UPDATE goal_directory_history SET current_identity=? WHERE directory=? AND current_identity=?').run(record.current, directory, record.previous);
  db.prepare('INSERT INTO goal_directory_history VALUES (?, ?, ?) ON CONFLICT(directory, previous_identity) DO UPDATE SET current_identity=excluded.current_identity')
    .run(directory, record.previous, record.current);
  db.prepare('DELETE FROM goal_ownership WHERE directory=? AND identity=?').run(record.staging, record.current);

  for (const table of ['goal_text_files', 'goal_text_contents']) db.prepare(`DELETE FROM ${table} WHERE directory=? AND identity=?`).run(record.staging, record.current);
  db.prepare('DELETE FROM goal_directory_recoveries WHERE directory=?').run(directory);
}

function sync(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function finish(root, directory) {
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    const record = saved(db, directory);

    if (!record) { db.exec('COMMIT');

    return; }

    validate(root, directory, record);

    if (assets.identity(directory) !== record.current) throw new Error('Recovered goal folder was replaced');
    sync(directory); sync(path.dirname(directory));
    moveRecords(db, directory, record);
    db.exec('COMMIT');
  } finally { db.close(); }
}

function recoverPublished(root, directory) {
  const db = open(root);
  let record;

  try { record = saved(db, directory); }
  finally { db.close(); }

  if (!record || !assets.exists(directory)) return;
  const release = assets.acquire(root);

  try { finish(root, directory); }
  finally { release(); }
}

function begin(root, directory) {
  if (!assets.validPath(root, directory)) throw new Error('Invalid goal recovery destination');
  const db = open(root);

  try {
    const pending = saved(db, directory);

    if (pending) {
      validate(root, directory, pending);
      checkPreparation(db, directory, pending);

      if (assets.identity(pending.staging) !== pending.current) throw new Error('Goal recovery staging folder was replaced');

      return pending;
    }

    return prepare(root, db, directory);
  } finally { db.close(); }
}

function prepare(root, db, directory) {
  const rows = db.prepare('SELECT identity, record_json FROM goal_preparations WHERE directory=? AND record_json IS NOT NULL').all(directory);

  if (rows.length !== 1) throw new Error('Goal folder recovery requires one saved preparation');
  const preparation = JSON.parse(rows[0].record_json);

  if (!preparation.input && !preparation.files) throw new Error('Goal attachment contents were not saved');
  const allocation = ownership.allocate(root, path.dirname(directory));
  ownership.save(root, allocation.directory, { version: 1, kind: 'goal-assets', owners: [{ sessionId: preparation.sessionId, sessionPath: preparation.sessionPath }] });
  const record = { staging: allocation.directory, previous: rows[0].identity, current: allocation.identity, preparation: rows[0].record_json };
  checkPreparation(db, directory, record);
  sync(record.staging); sync(path.dirname(directory));
  db.prepare('INSERT INTO goal_directory_recoveries VALUES (?, ?)').run(directory, JSON.stringify(record));

  return record;
}

module.exports = { begin, finish, recoverPublished };
