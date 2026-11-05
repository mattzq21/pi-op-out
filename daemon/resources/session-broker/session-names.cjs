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

function sessionName(file, sessionId) { return database.sessionNameOf(database.storageRoot(file), sessionId); }

const nameSession = onMainThread('session-names.nameSession', (file, sessionId, name, replace = true) => {
  const root = database.storageRoot(file);

  database.transaction(root, 'IMMEDIATE', () => {
    database.register(root, sessionId, file);
    database.saveSessionName(root, sessionId, validName(name), replace);
  });
});

const renameSession = onMainThread('session-names.renameSession', (root, sessionId, name) => {
  return database.transaction(root, 'IMMEDIATE', () => {
    if (!database.isSavedSession(root, sessionId)) throw new Error('Conversation not found');
    database.saveSessionName(root, sessionId, validName(name), true);

    return database.sessionNameOf(root, sessionId);
  });
});

module.exports = { capSessionName, promptName, validName, sessionName, nameSession, renameSession };
