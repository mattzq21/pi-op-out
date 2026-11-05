const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');

const MAX_NAME_LENGTH = 50;

function capSessionName(name) { return Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('').trimEnd(); }

function promptName(prompt) { return capSessionName(prompt.replace(/\[((?:\\.|[^\]\\])*)\]\([^)\s]*\)/g, (_link, label) => label.replace(/\\(.)/g, '$1'))); }

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
  const db = database.connection(root);

  return database.transaction(db, 'IMMEDIATE', () => work(db));
}

function sessionName(file, sessionId, connection) {
  return nameOf(connection ?? database.connection(database.storageRoot(file)), sessionId);
}

const nameSession = onMainThread('session-names.nameSession', (file, sessionId, name, replace = true) => {
  transaction(database.storageRoot(file), db => {
    database.register(db, sessionId, file);
    write(db, sessionId, name, replace);
  });
});

const renameSession = onMainThread('session-names.renameSession', (root, sessionId, name) => {
  return transaction(root, db => {
    if (!db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(sessionId)) throw new Error('Conversation not found');
    write(db, sessionId, name, true);

    return nameOf(db, sessionId);
  });
});

module.exports = { capSessionName, promptName, validName, sessionName, nameSession, renameSession, nameOf };
