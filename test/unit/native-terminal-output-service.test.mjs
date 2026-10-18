import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeTerminals } from '../../clients/ui/lib/nativeTerminals.ts';

test('a terminal list answered before the terminal restarts shows only the new terminal output', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const old = Promise.withResolvers(), fresh = Promise.withResolvers(), held = Promise.withResolvers(), release = Promise.withResolvers();
  let output = '', holding = false;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('old-output')) old.resolve();
    if (output.includes('fresh-output')) fresh.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const result = await daemon.invoke(args.command, args.args);
    if (holding && args.command === 'shared_terminal' && args.args.action === 'list') {
      holding = false;
      held.resolve();
      await release.promise;
    }
    return result;
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  let listing;
  try {
    await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'old-' 'output'\r", 'write');
    await old.promise;
    const [before] = await nativeTerminals.list(session, 'local');
    assert.equal(before.output.includes('old-output'), true);
    holding = true;
    listing = nativeTerminals.list(session, 'local');
    await held.promise;
    await nativeTerminals.close(terminal);
    await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
    release.resolve();
    const restarted = await listing;
    assert.equal(restarted.length, 1);
    assert.notEqual(restarted[0].generation, before.generation);
    assert.equal(restarted[0].output.includes('old-output'), false);
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'fresh-' 'output'\r", 'write');
    await fresh.promise;
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.generation, restarted[0].generation);
    assert.equal(listed.output.includes('old-output'), false);
    assert.equal(listed.output.split('fresh-output').length - 1, 1);
  } finally {
    release.resolve();
    await listing?.catch(() => undefined);
    await nativeTerminals.close(terminal);
  }
});

test('listing again with no new terminal output keeps the earlier text and returns the latest draft, then adds new output once', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  let output = '';
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('first-output')) first.resolve();
    if (output.includes('second-output')) second.resolve();
  });
  const listReplies = [];
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const result = await daemon.invoke(args.command, args.args);
    if (args.command === 'shared_terminal' && args.args.action === 'list') listReplies.push(result);
    return result;
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  const program = "sh -c 'printf %s%s\\\\n first- output; read line; printf %s%s\\\\n second- output; read line'";
  await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
  try {
    await nativeTerminals.write(terminal, program + '\r', 'write');
    await first.promise;
    const [before] = await nativeTerminals.list(session, 'local');
    assert.equal(before.output.split('first-output').length - 1, 1);
    await nativeTerminals.write(terminal, 'first draft', 'draft');
    const [drafted] = await nativeTerminals.list(session, 'local');
    await nativeTerminals.write(terminal, 'second draft', 'draft');
    const [redrafted] = await nativeTerminals.list(session, 'local');
    assert.deepEqual(listReplies.slice(-2).map(([reply]) => reply.output), [null, null]);
    assert.deepEqual([drafted.output, drafted.inputDraft], [before.output, 'first draft']);
    assert.deepEqual([redrafted.output, redrafted.inputDraft], [before.output, 'second draft']);
    await nativeTerminals.write(terminal, 'go\r', 'write');
    await second.promise;
    const [after] = await nativeTerminals.list(session, 'local');
    assert.equal(after.output.split('first-output').length - 1, 1);
    assert.equal(after.output.split('second-output').length - 1, 1);
    assert.equal(after.inputDraft, 'second draft');
  } finally {
    await nativeTerminals.close(terminal);
  }
});

test('a source conversation list answered before its terminal moves away returns nothing, and the destination keeps the terminal output and draft', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const before = Promise.withResolvers(), after = Promise.withResolvers(), held = Promise.withResolvers(), release = Promise.withResolvers();
  let output = '', holding = false;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('before-move')) before.resolve();
    if (output.includes('after-move')) after.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const result = await daemon.invoke(args.command, args.args);
    if (holding && args.command === 'shared_terminal' && args.args.action === 'list') {
      holding = false;
      held.resolve();
      await release.promise;
    }
    return result;
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const source = `local:draft-${crypto.randomUUID()}`;
  const destination = `local:draft-${crypto.randomUUID()}`;
  let listing;
  try {
    await nativeTerminals.start(terminal, source, chat.cwd, 80, 24, 'local');
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'before-' 'move'\r", 'write');
    await before.promise;
    await nativeTerminals.write(terminal, 'kept draft', 'draft');
    const [listed] = await nativeTerminals.list(source, 'local');
    assert.equal(listed.output.includes('before-move'), true);
    assert.equal(listed.inputDraft, 'kept draft');
    holding = true;
    listing = nativeTerminals.list(source, 'local');
    await held.promise;
    await nativeTerminals.reassign(terminal, destination);
    release.resolve();
    assert.deepEqual(await listing, []);
    const moved = await nativeTerminals.list(destination, 'local');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].id, terminal);
    assert.equal(moved[0].generation, listed.generation);
    assert.equal(moved[0].output.split('before-move').length - 1, 1);
    assert.equal(moved[0].inputDraft, 'kept draft');
    assert.deepEqual(await nativeTerminals.list(source, 'local'), []);
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'after-' 'move'\r", 'write');
    await after.promise;
    const [later] = await nativeTerminals.list(destination, 'local');
    assert.equal(later.output.split('before-move').length - 1, 1);
    assert.equal(later.output.split('after-move').length - 1, 1);
  } finally {
    release.resolve();
    await listing?.catch(() => undefined);
    await nativeTerminals.close(terminal);
  }
});
