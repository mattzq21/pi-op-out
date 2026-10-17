import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.stop(); });

const remove = (path: string) => daemon.invoke('remove_temporary_chat', { hostId: 'local', path });

test('removing a temporary chat deletes its empty folder but keeps files the agent made', async () => {
  const unused = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  expect(existsSync(unused.cwd)).toBe(true);
  await remove(unused.cwd);
  expect(existsSync(unused.cwd)).toBe(false);
  const used = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  writeFileSync(join(used.cwd, 'scratch.py'), 'print(1)');
  await remove(used.cwd);
  expect(existsSync(join(used.cwd, 'scratch.py'))).toBe(true);
}, 60000);

test('removing a temporary chat refuses every folder that is not a temporary chat folder', async () => {
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const project = join(daemon.home, 'project');
  mkdirSync(project);
  for (const path of [project, join(daemon.home, '.piop/tmp'), join(chat.cwd, 'nested'), join(project, '.piop/tmp', chat.sessionId)]) {
    expect(await daemon.failure('remove_temporary_chat', { hostId: 'local', path })).toMatch(/Refusing to remove a directory/);
  }
  expect(existsSync(project)).toBe(true);
  expect(existsSync(chat.cwd)).toBe(true);
}, 60000);
