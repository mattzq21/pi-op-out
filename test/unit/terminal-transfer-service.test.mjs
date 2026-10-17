import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeTerminals } from '../../clients/ui/lib/nativeTerminals.ts';
import { beginBranching } from '../../clients/ui/lib/branchActivity.ts';

test('one failed terminal transfer does not prevent transferring the other tabs', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const healthy = crypto.randomUUID();
  const response = Promise.withResolvers();
  let output = '';
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== healthy) return;
    output += payload.data;
    if (output.includes('transfer-works')) response.resolve();
  });
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const source = `local:draft-${crypto.randomUUID()}`;
  const destination = `local:draft-${crypto.randomUUID()}`;
  await nativeTerminals.start(healthy, source, chat.cwd, 80, 24, 'local');
  try {
    const before = await nativeTerminals.list(source, 'local');
    assert.equal(before.length, 1);
    assert.equal(before[0].id, healthy);
    assert.equal(before[0].started, true);
    const results = await Promise.allSettled([
      nativeTerminals.reassign(crypto.randomUUID(), destination),
      nativeTerminals.reassign(healthy, destination),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.match(String(results[0].reason), /Terminal is unavailable/);
    assert.equal(results[1].status, 'fulfilled');
    assert.deepEqual(await nativeTerminals.list(source, 'local'), []);
    const moved = await nativeTerminals.list(destination, 'local');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].id, healthy);
    assert.equal(moved[0].generation, before[0].generation);
    assert.equal(moved[0].owned, true);
    assert.equal(moved[0].exited, false);
    await nativeTerminals.write(healthy, "printf '%s%s\\n' 'transfer-' 'works'\r");
    await response.promise;
  } finally {
    await nativeTerminals.close(healthy);
  }
});

test('terminal input and resize wait for a fork and its terminal transfer', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const received = Promise.withResolvers(), release = Promise.withResolvers(), response = Promise.withResolvers();
  let output = '', transferred = false;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('queued-input') && /30 100\r?\n/.test(output)) response.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    if (args.command === 'shared_terminal' && args.args.action === 'reassign') {
      received.resolve();
      await release.promise;
      const result = await daemon.invoke(args.command, args.args);
      transferred = true;
      return result;
    }
    if (args.command === 'shared_terminal' && ['write_with_draft', 'resize'].includes(args.args.action)) {
      assert.equal(transferred, true, 'input and resize must wait until the terminal has moved');
    }
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const source = `local:draft-${crypto.randomUUID()}`, destination = `local:draft-${crypto.randomUUID()}`;
  await nativeTerminals.start(terminal, source, chat.cwd, 80, 24, 'local');
  const finish = beginBranching();
  const writing = nativeTerminals.write(terminal, "printf '%s%s\\n' 'queued-' 'input'\r");
  const resizing = nativeTerminals.resize(terminal, 100, 30);
  const work = [writing, resizing];
  try {
    assert.equal((await nativeTerminals.list(source, 'local')).length, 1);
    work.push(nativeTerminals.reassign(terminal, destination));
    finish();
    await received.promise;
    const waiting = await nativeTerminals.list(source, 'local');
    assert.equal(waiting[0].id, terminal);
    assert.equal(waiting[0].output.includes('queued-input'), false);
    release.resolve();
    await Promise.all(work);
    assert.deepEqual(await nativeTerminals.list(source, 'local'), []);
    assert.equal((await nativeTerminals.list(destination, 'local'))[0].id, terminal);
    await nativeTerminals.write(terminal, 'stty size\r');
    await response.promise;
  } finally {
    finish(); release.resolve();
    await Promise.allSettled(work);
    await nativeTerminals.close(terminal);
  }
});

test('input queued behind a failed terminal transfer is rejected and a retry runs in the original session', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const response = Promise.withResolvers();
  let output = '';
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('retry-works')) response.resolve();
  });
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const source = `local:draft-${crypto.randomUUID()}`;
  const unowned = `local:${crypto.randomUUID()}`;
  await nativeTerminals.start(terminal, source, chat.cwd, 80, 24, 'local');
  try {
    const transfer = nativeTerminals.reassign(terminal, unowned);
    const writing = nativeTerminals.write(terminal, "printf '%s%s\\n' 'first-' 'attempt'\r");
    const [moved, written] = await Promise.allSettled([transfer, writing]);
    assert.equal(moved.status, 'rejected');
    assert.match(String(moved.reason), /Take ownership of the destination session first/);
    assert.equal(written.status, 'rejected');
    assert.match(String(written.reason), /Take ownership of the destination session first/);
    await nativeTerminals.write(terminal, "printf '%s%s\\n' 'retry-' 'works'\r");
    await response.promise;
    assert.equal(output.includes('first-attempt'), false);
    assert.deepEqual((await nativeTerminals.list(source, 'local')).map(item => item.id), [terminal]);
  } finally {
    await nativeTerminals.close(terminal);
  }
});

test('a failed transfer into a session does not hide the terminals already in that session', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const resident = crypto.randomUUID(), closed = crypto.randomUUID();
  const daemon = await daemonClient(t);
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const source = `local:draft-${crypto.randomUUID()}`, destination = `local:draft-${crypto.randomUUID()}`;
  await nativeTerminals.start(resident, destination, chat.cwd, 80, 24, 'local');
  await nativeTerminals.start(closed, source, chat.cwd, 80, 24, 'local');
  await nativeTerminals.close(closed);
  try {
    const [moved, listed] = await Promise.allSettled([nativeTerminals.reassign(closed, destination), nativeTerminals.list(destination, 'local')]);
    assert.equal(moved.status, 'rejected');
    assert.match(String(moved.reason), /Terminal is unavailable/);
    assert.equal(listed.status, 'fulfilled', String(listed.reason));
    assert.deepEqual(listed.value.map(item => [item.id, item.exited]), [[resident, false]]);
  } finally {
    await nativeTerminals.close(resident);
  }
});
