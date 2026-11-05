import { createHash } from 'node:crypto';
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

const registerExternalTranscript = onMainThread('session-registry.registerExternalTranscript', (root: string, transcript: string | undefined, sessionId?: string) => {
  if (!transcript) return;
  const file = path.resolve(transcript);
  const relative = path.relative(root, file);

  if (["sessions", "archived"].some(area => relative.startsWith(area + path.sep))) return;
  sessionTables.saveExternalTranscript(root, createHash("sha256").update(file).digest("hex"), JSON.stringify({ path: file, sessionId }));
});

function saveManagedMetadata(root: string, id: string, file: string, saved: boolean): void {
  if (!saved) {
    sessionTables.markSessionFileWrite(root, id);

    return;
  }

  const metadata = fs.lstatSync(file, { bigint: true });

  if (!metadata.isFile()) throw new Error("Saved session is not a regular file");
  sessionTables.saveRegisteredFileMetadata(root, id, file, String(metadata.mtimeNs), metadata.size);
}

const bindSession = onMainThread('session-registry.bindSession', (root: string, id: string, file: string) => sessionTables.bind(root, id, file));

function requireSession(root, id, file) { return sessionTables.register(root, id, file); }

const recordTranscript = onMainThread('session-registry.recordTranscript', (root: string, id: string, file: string, saved: boolean) => {
  return sessionTables.transaction(root, 'IMMEDIATE', () => {
    sessionTables.register(root, id, file);
    saveManagedMetadata(root, id, file, saved);
  });
});

function sessionPath(root, id) { return sessionTables.lookup(root, id); }

export { recordDirectory, bindSession, requireSession, recordTranscript, sessionPath, registerExternalTranscript };
