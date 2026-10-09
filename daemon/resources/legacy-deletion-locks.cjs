const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

const namePattern = /^\.delete-[a-f0-9]{64}\.lock$/;

function metadata(directory) {
  try { return fs.lstatSync(directory, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function identity(directory, info) {
  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Legacy deletion lock directory changed');

  return `${info.dev}:${info.ino}`;
}

function importDirectory(db, directory) {
  const info = metadata(directory);

  if (!info) return;
  identity(directory, info);

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (namePattern.test(entry.name)) {
      db.prepare('INSERT INTO legacy_deletion_locks VALUES (?, ?)').run(file, identity(file, fs.lstatSync(file, { bigint: true })));
    } else if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) importDirectory(db, file);
  }
}

function importRecords(db, root) {
  if (db.prepare("SELECT 1 FROM storage_migrations WHERE name='legacy-deletion-locks-v1'").get()) return;
  db.exec('BEGIN IMMEDIATE');

  try {
    if (!db.prepare("SELECT 1 FROM storage_migrations WHERE name='legacy-deletion-locks-v1'").get()) {
      for (const area of ['sessions', 'archived']) importDirectory(db, path.join(root, area));
      db.prepare("INSERT INTO storage_migrations VALUES ('legacy-deletion-locks-v1')").run();
    }

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function present(db, root, record) {
  const relative = path.relative(root, record.directory).split(path.sep);

  if (!['sessions', 'archived'].includes(relative[0]) || relative.includes('..') || !namePattern.test(path.basename(record.directory))) throw new Error('Invalid registered deletion lock');
  const info = metadata(record.directory);

  if (!info) {
    require('./legacy-deletion-records.cjs').remove(root, record.directory);
    db.prepare('DELETE FROM legacy_deletion_locks WHERE directory=? AND identity=?').run(record.directory, record.identity);

    return false;
  }

  if (identity(record.directory, info) !== record.identity) throw new Error('Registered deletion lock was replaced');

  return true;
}

function list(root) {
  const db = database.open(root);

  try {
    importRecords(db, root);

    return db.prepare('SELECT directory, identity FROM legacy_deletion_locks ORDER BY directory').all()
      .filter(record => present(db, root, record)).map(record => record.directory);
  } finally { db.close(); }
}

module.exports = { list };
