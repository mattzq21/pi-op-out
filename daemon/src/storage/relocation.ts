import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as database from '../session-database/index.ts';
import { storagePublish } from '../piop-storage/index.ts';
import { readSessionHeader } from './session-header.ts';

function relocateSession(profile: string, sessionPath: string, requestedReplacement: string, from?: string) {
  const replacement = fs.realpathSync(requestedReplacement);

  if (!fs.statSync(replacement).isDirectory()) throw new Error('Project directory does not exist');
  rewriteHeader(profile, sessionPath, replacement, from);
}

// Writes the transcript again with cwd replacement, at the same path. With from, only a transcript that works in from.
function rewriteHeader(profile: string, sessionPath: string, replacement: string, from?: string) {
  const lines = fs.readFileSync(sessionPath, 'utf8').split('\n');
  const header = JSON.parse(lines[0]);

  if (header.type !== 'session') throw new Error('Invalid session header');

  if (from !== undefined && header.cwd !== from) return;
  header.cwd = replacement;
  lines[0] = JSON.stringify(header);
  database.revise(profile, header.id);
  storagePublish(sessionPath, join(dirname(sessionPath), `.${basename(sessionPath)}.relocate`), lines.join('\n'), false);
}

function checkedRelocation(request: any) {
  if (typeof request.profile !== 'string' || typeof request.sessionPath !== 'string' || typeof request.cwd !== 'string' || (request.from !== undefined && typeof request.from !== 'string')) throw new Error('Invalid relocation request');
  let root, source;

  try { root = fs.realpathSync(join(request.profile, 'sessions')); } catch (error) { throw new Error(`Could not locate piop sessions: ${error.message}`); }

  try { source = fs.realpathSync(request.sessionPath); } catch (error) { throw new Error(`Could not locate session file: ${error.message}`); }

  if (!source.startsWith(root + '/') || !source.endsWith('.jsonl') || !fs.statSync(source).isFile()) throw new Error('Refusing to relocate a non-desktop session file');
  const replacement = request.cwd.trim();
  let directory = false;

  try { directory = fs.statSync(replacement).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new Error(`Could not check project directory ${replacement}: ${error.message}`); }

  if (!directory) throw new Error(`Project directory does not exist: ${replacement}`);
  relocateSession(request.profile, source, replacement, request.from);

  return null;
}

// Gives a chat whose working folder is missing a new empty folder, <profile>/recovery/<chat ID>, and writes that folder
// into the transcript header. A repeat after a stop between the two steps uses the same folder.
function recoverMissingSession(request: { action: string; profile: string; sessionPath: string }) {
  if (request.action !== 'empty') throw new Error('Unknown recovery action');
  if (typeof request.profile !== 'string' || typeof request.sessionPath !== 'string') throw new Error('Invalid recovery request');
  const header = readSessionHeader(request.sessionPath);

  if (!header) throw new Error('Invalid session directory');
  const directory = join(fs.realpathSync(request.profile), 'recovery', header.id);

  if (header.cwd !== directory && fs.lstatSync(header.cwd, { throwIfNoEntry: false })) throw new Error('The session directory exists again. Refresh the session list before opening it.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (header.cwd !== directory) relocateSession(request.profile, request.sessionPath, directory);

  return { cwd: directory, warnings: [] };
}

export { relocateSession, checkedRelocation, recoverMissingSession };
