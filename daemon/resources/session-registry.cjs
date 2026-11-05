const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sessionTables = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');

function directoryExists(cwd) {
  let exists;

  try { exists = fs.statSync(cwd).isDirectory(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; exists = false; }

  return exists;
}

function registeredSession(root, session) {
  if (!path.isAbsolute(session.sessionPath || '')) return false;

  return sessionTables.isRegistered(root, session.sessionId, session.sessionPath);
}

const saveDirectory = onMainThread('session-registry.saveDirectory', (root, session, checked, exists) => {
  sessionTables.transaction(root, 'IMMEDIATE', () => {
    if (registeredSession(root, session)) sessionTables.saveSessionDirectory(root, session.sessionId, session.cwd, checked, exists);
  });
});

// Checks the folder of a chat, which can be slow on a network folder, and saves whether it exists.
function recordDirectory(request) {
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('Invalid session registry root');
  const session = { sessionId: request.sessionId, sessionPath: request.sessionPath, cwd: request.cwd };

  if (!session.sessionId || !path.isAbsolute(session.cwd || '') || !registeredSession(request.root, session)) return null;
  saveDirectory(request.root, session, request.checkedAt || Date.now(), directoryExists(session.cwd));

  return null;
}

const registerExternalTranscript = onMainThread('session-registry.registerExternalTranscript', (root, transcript, sessionId) => {
  if (!transcript) return;
  const file = path.resolve(transcript);
  const relative = path.relative(root, file);

  if (["sessions", "archived"].some(area => relative.startsWith(area + path.sep))) return;
  sessionTables.saveExternalTranscript(root, createHash("sha256").update(file).digest("hex"), JSON.stringify({ path: file, sessionId }));
});

function saveManagedMetadata(root, id, file, saved) {
  if (!saved) {
    sessionTables.markSessionFileWrite(root, id);

    return;
  }

  const metadata = fs.lstatSync(file, { bigint: true });

  if (!metadata.isFile()) throw new Error("Saved session is not a regular file");
  sessionTables.saveRegisteredFileMetadata(root, id, file, String(metadata.mtimeNs), metadata.size);
}

const bindSession = onMainThread('session-registry.bindSession', (root, id, file) => sessionTables.bind(root, id, file));

function requireSession(root, id, file) { return sessionTables.register(root, id, file); }

const recordTranscript = onMainThread('session-registry.recordTranscript', (root, id, file, saved) => {
  return sessionTables.transaction(root, 'IMMEDIATE', () => {
    sessionTables.register(root, id, file);
    saveManagedMetadata(root, id, file, saved);
  });
});

function sessionPath(root, id) { return sessionTables.lookup(root, id); }

module.exports = { recordDirectory, bindSession, requireSession, recordTranscript, sessionPath, registerExternalTranscript };
