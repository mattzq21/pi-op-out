const database = require('./session-database.cjs');

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM legacy_committed_deletions ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

function remove(root, directory) {
  const db = database.open(root);

  try { db.prepare('DELETE FROM legacy_committed_deletions WHERE directory=?').run(directory); }
  finally { db.close(); }
}

module.exports = { list, remove };
