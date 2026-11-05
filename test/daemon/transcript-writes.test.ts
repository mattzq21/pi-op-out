import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
const database = require('../../daemon/resources/session-database.ts');
const core = require('../../daemon/resources/session-database/core.ts');
let writes: any;
let mailbox: any;

beforeAll(async () => {
  root = join(realpathSync(mkdtempSync(join(tmpdir(), 'piop-transcript-writes-'))), '.piop');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writes = (await import('../../daemon/resources/piop-storage/transcript-writes.ts')).OPERATIONS;
  mailbox = (await import('../../daemon/resources/piop-storage/mailbox-store.ts')).OPERATIONS;
});
afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

test('each transcript write moves the chat revision, and the saved agent mail follows the transcript', () => {
  const id = database.reserve(root);
  const path = join(root, 'sessions', `chat_${id}.jsonl`);
  const timestamp = new Date().toISOString();
  const header = { type: 'session', version: 3, id, timestamp, cwd: root };
  const question = { type: 'message', id: 'u1', parentId: null, timestamp, message: { role: 'user', content: 'Hello', timestamp: 1 } };
  const mail = { type: 'custom_message', id: 'm1', parentId: 'u1', timestamp, customType: 'piop-agent-message', content: 'Mail', display: true,
    details: { notificationId: 'delivery', mailboxSessionId: id, mailboxFingerprint: 'print' } };
  const revision = () => core.connection(root).prepare('SELECT revision FROM sessions WHERE session_id=?').get(id).revision;
  const saved = () => mailbox.saved(root, { sessionId: id, path });

  writes.publish(root, { path, entries: [header, question], exclusive: true });
  expect(database.lookup(root, id)).toBe(path);
  const created = revision();
  writes.append(root, { path, sessionId: id, entry: mail, after: null });
  expect(revision()).toBeGreaterThan(created);
  expect(saved()).toEqual([['delivery', 'print']]);

  const appended = revision();
  writes.publish(root, { path, entries: [header, question], exclusive: false });
  expect(revision()).toBeGreaterThan(appended);
  expect(saved()).toEqual([]);
});
