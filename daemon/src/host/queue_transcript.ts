import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorText } from '../util/sync';
import { parseIdentity } from './queue_storage';

/** Reads user messages from a saved transcript, so the queue can tell which items Pi already took. */
export function savedUserMessages(path: string, sessionId: string): any[] {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Cannot verify saved queued input: ' + (error?.message ?? error));
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Queued-input transcript must be a regular file');
    const content = readFileSync(fd);
    const messages = readUserMessages(content, sessionId);
    if (messages.length) {
      try { fsyncSync(fd); } catch (error) { throw new Error('Cannot sync saved queued input: ' + errorText(error)); }
      try {
        const directory = openSync(dirname(path), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } catch (error) { throw new Error('Cannot sync queued-input transcript directory: ' + errorText(error)); }
    }
    return messages;
  } finally { closeSync(fd); }
}

function readUserMessages(content: Buffer, sessionId: string): any[] {
  let offset = 0;
  const next = (): any | undefined => {
    const end = content.indexOf(10, offset);
    if (end < 0) return undefined;
    const line = content.subarray(offset, end + 1).toString('utf8');
    offset = end + 1;
    try { return JSON.parse(line); } catch (error) { throw new Error('Cannot verify queued-input transcript: ' + errorText(error)); }
  };
  const header = next();
  if (header === undefined) return [];
  let expected: string;
  try { expected = parseIdentity(sessionId); } catch { throw new Error('Invalid queued-input session identity'); }
  let identity: string | undefined;
  try { identity = typeof header?.id === 'string' ? parseIdentity(header.id) : undefined; } catch {}
  if (header?.type !== 'session' || identity !== expected) throw new Error('Queued-input transcript belongs to a different conversation');
  const messages: any[] = [];
  for (let entry = next(); entry !== undefined; entry = next()) {
    if (entry?.type === 'message' && entry?.message?.role === 'user') messages.push(entry.message);
  }
  return messages;
}
