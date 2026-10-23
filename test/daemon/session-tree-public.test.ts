import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.stop(); });

type Chat = { id: string; path: string };
const fixture = (input: unknown): { root: Chat; child: Chat; grandchild: Chat; other: Chat } => JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-session-tree.mjs', import.meta.url))], { encoding: 'utf8', timeout: 60000, input: JSON.stringify(input) }));

/** A chat with a subagent that has its own subagent, plus an unrelated chat in the same project. */
function sessionTree(project: string) {
  const cwd = join(daemon.home, project); mkdirSync(cwd, { recursive: true });
  return fixture({ home: daemon.home, cwd, folder: project });
}

const listedIds = async () => new Set((await daemon.invoke('list_sessions')).map((session: any) => session.id));
const archives = async () => (await daemon.invoke('storage_report')).hosts[0].archives as Array<{ id: string; path: string }>;
const archivedIds = async () => new Set((await archives()).map(archive => archive.id));

test('archiving a chat archives its subagent chats with it and leaves other chats', async () => {
  const tree = sessionTree('archive-tree');
  const parents = new Map((await daemon.invoke('list_sessions')).map((session: any) => [session.id, session.subagentParentId]));
  expect([parents.get(tree.child.id), parents.get(tree.grandchild.id)]).toEqual([tree.root.id, tree.child.id]);
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: tree.root.path, terminalIds: [], clientId: 'laptop' });
  const listed = await listedIds();
  const archived = await archivedIds();
  for (const chat of [tree.root, tree.child, tree.grandchild]) {
    expect([listed.has(chat.id), archived.has(chat.id), existsSync(chat.path)]).toEqual([false, true, false]);
  }
  expect([listed.has(tree.other.id), existsSync(tree.other.path)]).toEqual([true, true]);
}, 120000);

test('restoring an archived chat brings its subagent chats back', async () => {
  const tree = sessionTree('restore-tree');
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: tree.root.path, terminalIds: [], clientId: 'laptop' });
  const before = await archivedIds();
  expect([before.has(tree.child.id), before.has(tree.grandchild.id)]).toEqual([true, true]);
  const archivedRoot = (await archives()).find(archive => archive.id === tree.root.id)!;
  await daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archivedRoot.path, clientId: 'laptop' });
  const listed = await listedIds();
  const archived = await archivedIds();
  for (const chat of [tree.root, tree.child, tree.grandchild]) expect([listed.has(chat.id), archived.has(chat.id)]).toEqual([true, false]);
}, 120000);

test('deleting a chat, active or archived, deletes its subagent chats and nothing else', async () => {
  const active = sessionTree('delete-active');
  await daemon.invoke('delete_session', { hostId: 'local', sessionPath: active.root.path, clientId: 'laptop' });
  for (const chat of [active.root, active.child, active.grandchild]) expect([(await listedIds()).has(chat.id), existsSync(chat.path)]).toEqual([false, false]);
  expect(existsSync(active.other.path)).toBe(true);
  const archived = sessionTree('delete-archived');
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: archived.root.path, terminalIds: [], clientId: 'laptop' });
  const archivedRoot = (await archives()).find(archive => archive.id === archived.root.id)!;
  await daemon.invoke('delete_archived_session', { hostId: 'local', sessionPath: archivedRoot.path, clientId: 'laptop' });
  const left = await archivedIds();
  for (const chat of [archived.root, archived.child, archived.grandchild]) expect(left.has(chat.id)).toBe(false);
  expect((await listedIds()).has(archived.other.id)).toBe(true);
}, 120000);
