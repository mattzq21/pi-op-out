import fs from 'node:fs';
import path from 'node:path';
import * as sessionTables from './session-database.ts';
import { onMainThread } from './main-thread.ts';

interface DirectorySession { sessionId: string; sessionPath: string; cwd: string }

function directoryExists(cwd) {
  let exists;

  try { exists = fs.statSync(cwd).isDirectory(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; exists = false; }

  return exists;
}

function registeredSession(root: string, session: DirectorySession): boolean {
  if (!path.isAbsolute(session.sessionPath || '')) return false;

  return sessionTables.isRegistered(root, session.sessionId, session.sessionPath);
}

const saveDirectory = onMainThread('session-registry.saveDirectory', (root: string, session: DirectorySession, checked: number, exists: boolean) => {
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

function sessionPath(root, id) { return sessionTables.lookup(root, id); }

export { recordDirectory, sessionPath };
