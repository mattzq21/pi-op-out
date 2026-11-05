import fs from 'node:fs';
import path from 'node:path';
import { readSessionHeader } from './session-header.ts';
import { relocateSession } from './relocate-session.ts';

// Gives a chat whose working folder is missing a new empty folder, <profile>/recovery/<chat ID>, and writes that folder
// into the transcript header. A repeat after a stop between the two steps uses the same folder.
function recoverMissingSession(request) {
  if (request.action !== 'empty') throw new Error('Unknown recovery action');
  if (typeof request.profile !== 'string' || typeof request.sessionPath !== 'string') throw new Error('Invalid recovery request');
  const header = readSessionHeader(request.sessionPath);

  if (!header) throw new Error('Invalid session directory');
  const directory = path.join(fs.realpathSync(request.profile), 'recovery', header.id);

  if (header.cwd !== directory && fs.lstatSync(header.cwd, { throwIfNoEntry: false })) throw new Error('The session directory exists again. Refresh the session list before opening it.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (header.cwd !== directory) relocateSession(request.profile, request.sessionPath, directory);

  return { cwd: directory, warnings: [] };
}

export { recoverMissingSession };
