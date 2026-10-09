const database = require('./session-database.cjs');

function invalidate(file) {
  let root;

  try { root = database.storageRoot(file); }
  catch { return; }

  const db = database.open(root);

  try { db.prepare('DELETE FROM session_file_metadata WHERE session_path=?').run(file); }
  finally { db.close(); }
}

module.exports = { invalidate };
