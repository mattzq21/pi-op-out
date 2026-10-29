const database = require('../session-database.cjs');

// Chat names. The session broker owns them: Pi sessions have no name. This module is the only code that reads or writes them.

const MAX_NAME_LENGTH = 50;

function capSessionName(name) { return Array.from(name.trim()).slice(0, MAX_NAME_LENGTH).join('').trimEnd(); }

function validName(name) {
  if (typeof name !== 'string') throw new Error('A conversation name must be text');
  const capped = capSessionName(name);

  if (!capped) throw new Error("Conversation name can't be empty");

  return capped;
}

function nameOf(db, sessionId) { return db.prepare('SELECT name FROM session_names WHERE session_id=?').get(sessionId)?.name; }

function write(db, sessionId, name, replace) {
  db.prepare(`INSERT INTO session_names (session_id, name) VALUES (?, ?) ON CONFLICT(session_id) DO ${replace ? 'UPDATE SET name=excluded.name' : 'NOTHING'}`).run(sessionId, validName(name));
}

function transaction(root, work) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    const result = work(db);
    db.exec('COMMIT');

    return result;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

/** The name of the chat sessionId whose transcript is file, or undefined. connection: an open database of the same storage profile. */
function sessionName(file, sessionId, connection) {
  const db = connection ?? database.open(database.storageRoot(file));

  try { return nameOf(db, sessionId); }
  finally { if (!connection) db.close(); }
}

/** Names the new chat sessionId whose transcript is file. replace: false keeps a name it already has. */
function nameSession(file, sessionId, name, replace = true) {
  transaction(database.storageRoot(file), db => {
    database.register(db, sessionId, file);
    write(db, sessionId, name, replace);
  });
}

/** Renames the saved chat sessionId of the storage profile root and returns its new name. */
function renameSession(root, sessionId, name) {
  return transaction(root, db => {
    if (!db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(sessionId)) throw new Error('Conversation not found');
    write(db, sessionId, name, true);

    return nameOf(db, sessionId);
  });
}

module.exports = { capSessionName, validName, sessionName, nameSession, renameSession, nameOf };
