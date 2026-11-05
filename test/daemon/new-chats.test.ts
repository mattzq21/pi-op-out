import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';

let home: string;
let root: string;
let folder: string;
let previousStorage: string | undefined;
const database = require('../../daemon/resources/session-database.cjs');
const newChats = require('../../daemon/resources/piop-storage/new-chats.cjs');
const lifecycle = require('../../daemon/resources/session-lifecycle.cjs');

beforeAll(() => {
  previousStorage = process.env.PIOP_STORAGE_DIRECTORY;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'piop-new-chats-')));
  root = join(home, '.piop');
  folder = join(root, 'sessions', 'project');
  mkdirSync(folder, { recursive: true });
  process.env.PIOP_STORAGE_DIRECTORY = relative(realpathSync(homedir()), root);
});
afterAll(() => {
  if (previousStorage === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = previousStorage;
  rmSync(home, { recursive: true, force: true });
});

function chat(id: string) {
  const timestamp = new Date().toISOString();
  return { path: join(folder, timestamp.replace(/[:.]/g, '-') + '_' + id + '.jsonl'), entries: [
    { type: 'session', version: 3, id, timestamp, cwd: home },
    { type: 'message', id: 'u1', parentId: null, timestamp, message: { role: 'user', content: 'Hello', timestamp: 1 } },
  ] };
}

const files = (id: string) => readdirSync(folder).filter(name => name.includes(id));

test('a chat that a stop leaves before its commit is not shown, and the start sweep removes its files', () => {
  const id = database.reserve(root);
  const left = chat(id);
  // What a stop after the transcript write leaves: the file at its path, and its reserved ID without a path.
  writeFileSync(left.path, left.entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  mkdirSync(left.path.replace(/\.jsonl$/, '.snapshots'));
  expect(lifecycle.session(root, id)).toBeUndefined();

  expect(lifecycle.sweep(root)).toEqual([]);
  expect(files(id)).toEqual([]);
});

test('a failed commit leaves no files and gives back the reserved ID', () => {
  const id = database.reserve(root);
  const db = database.connection(root);
  db.exec("CREATE TRIGGER reject_new_chat BEFORE INSERT ON auxiliary_child_state WHEN NEW.session_id='" + id + "' BEGIN SELECT RAISE(ABORT, 'Index write failed'); END");
  try { expect(() => newChats.create(root, chat(id))).toThrow(/^Index write failed$/); }
  finally { db.exec('DROP TRIGGER reject_new_chat'); }
  expect(files(id)).toEqual([]);
  expect(db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id) ?? null).toBeNull();
});

test('a new chat is saved with its name, records and link to its parent in one commit', () => {
  const parentId = database.reserve(root);
  const parent = chat(parentId);
  newChats.create(root, parent);
  const childId = database.reserve(root);
  const child = chat(childId);
  child.entries.push({ type: 'custom', id: 'marker', parentId: 'u1', timestamp: child.entries[0].timestamp, customType: 'piop-auxiliary-parent', data: { kind: 'btw', sessionId: childId, parentSessionId: parentId } } as any);
  newChats.create(root, { ...child, name: 'Side chat' });

  expect(lifecycle.session(root, childId)).toEqual({ sessionId: childId, sessionPath: child.path, archived: false });
  expect(lifecycle.descendants(root, parentId)).toEqual([{ sessionId: childId, sessionPath: child.path, archived: false }]);
  expect(database.connection(root).prepare('SELECT name FROM session_names WHERE session_id=?').get(childId)).toEqual({ name: 'Side chat' });
  expect(existsSync(child.path.replace(/\.jsonl$/, '.snapshots/new-chat.pending'))).toBe(false);
});
