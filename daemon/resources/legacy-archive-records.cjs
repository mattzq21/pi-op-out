const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM legacy_archive_directories ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

function exists(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Legacy archive directory was replaced');

    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function recover(root, directory, replay) {
  if (path.dirname(directory) !== root || !/^archive-transaction-[a-zA-Z0-9]{6}$/.test(path.basename(directory))) throw new Error('Unsupported legacy archive directory');

  if (exists(directory)) replay(root, directory);

  if (exists(directory)) return;
  const db = database.open(root);

  try { db.prepare('DELETE FROM legacy_archive_directories WHERE directory=?').run(directory); }
  finally { db.close(); }
}

module.exports = { list, recover };
