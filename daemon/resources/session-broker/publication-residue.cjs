const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');

function metadata(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function scan(db, directory, known) {
  const info = metadata(directory);

  if (!info) return;

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Legacy publication storage has ambiguous ancestry');

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) scan(db, file, known);
    else if (entry.isFile() && /\.jsonl\.[a-f0-9-]{36}\.tmp$/.test(entry.name) && !known.has(file)) {
      const info = fs.lstatSync(file, { bigint: true });

      const record = { version: 1, kind: 'unowned-session-publication', path: file, identity: `${info.dev}:${info.ino}`,
        reason: 'Legacy temporary transcript has no writer-death or ownership proof; retained in place' };

      db.prepare('INSERT INTO legacy_publication_residue VALUES (?, ?)').run(file, JSON.stringify(record));
    }
  }
}

function importRecords(db, root, known) {
  if (db.prepare("SELECT 1 FROM storage_migrations WHERE name='legacy-publication-residue-v1'").get()) return;
  db.exec('BEGIN IMMEDIATE');

  try {
    if (!db.prepare("SELECT 1 FROM storage_migrations WHERE name='legacy-publication-residue-v1'").get()) {
      for (const area of ['sessions', 'archived']) scan(db, path.join(root, area), known);
      db.prepare("INSERT INTO storage_migrations VALUES ('legacy-publication-residue-v1')").run();
    }

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function retained(db, root, row) {
  const relative = path.relative(root, row.path).split(path.sep);
  const record = JSON.parse(row.record_json);

  if (!['sessions', 'archived'].includes(relative[0]) || relative.includes('..') || record.path !== row.path) throw new Error('Invalid legacy publication record');
  const info = metadata(row.path);

  if (!info) {
    db.prepare('DELETE FROM legacy_publication_residue WHERE path=? AND record_json=?').run(row.path, row.record_json);

    return undefined;
  }

  if (!info.isFile() || fs.realpathSync(row.path) !== row.path || record.identity !== `${info.dev}:${info.ino}`) throw new Error('Legacy temporary transcript was replaced; retained');

  return record;
}

function list(root, known) {
  const db = database.open(root);

  try {
    importRecords(db, root, known);

    return db.prepare('SELECT path, record_json FROM legacy_publication_residue ORDER BY path').all()
      .filter(row => !known.has(row.path)).map(row => retained(db, root, row)).filter(Boolean);
  } finally { db.close(); }
}

module.exports = { list };
