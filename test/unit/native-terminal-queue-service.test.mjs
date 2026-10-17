import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeTerminals } from '../../clients/ui/lib/nativeTerminals.ts';
import { beginBranching } from '../../clients/ui/lib/branchActivity.ts';

test('typing that waits behind a slow draft save is sent once and the next draft stays', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const held = Promise.withResolvers(), release = Promise.withResolvers(), response = Promise.withResolvers();
  let output = '', holding = true;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('queued-send')) response.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    if (holding && args.command === 'shared_terminal' && args.args.action === 'draft') {
      holding = false;
      held.resolve();
      await release.promise;
    }
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  const typed = "printf '%s%s\\n' 'queued-' 'send'";
  await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
  const work = [];
  try {
    work.push(nativeTerminals.write(terminal, 'p', 'draft'));
    await held.promise;
    work.push(nativeTerminals.write(terminal, 'printf', 'draft'));
    work.push(nativeTerminals.write(terminal, typed, 'draft'));
    work.push(nativeTerminals.writeAndClearDraft(terminal, typed + '\r', typed));
    work.push(nativeTerminals.write(terminal, 'next command', 'draft'));
    await new Promise(resolve => setImmediate(resolve));
    release.resolve();
    const results = await Promise.allSettled(work);
    assert.deepEqual(results.map(result => result.status === 'rejected' ? String(result.reason) : result.status), Array(5).fill('fulfilled'));
    await response.promise;
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.inputDraft, 'next command');
    assert.equal(listed.output.split('queued-send').length - 1, 1);
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    await nativeTerminals.close(terminal);
  }
});

test('Enter queued before a connection change is cancelled, keeps the saved draft, and a retry sends it once', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const response = Promise.withResolvers();
  let output = '';
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('after-reconnect')) response.resolve();
  });
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  const typed = "printf '%s%s\\n' 'after-' 'reconnect'";
  await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
  await nativeTerminals.write(terminal, typed, 'draft');
  const finish = beginBranching();
  let cancelled;
  try {
    cancelled = nativeTerminals.write(terminal, '\r', 'write_with_draft');
    nativeTerminals.invalidateWrites('local');
    finish();
    await assert.rejects(cancelled, /Terminal connection changed\. Enter the input again\./);
    const [waiting] = await nativeTerminals.list(session, 'local');
    assert.equal(waiting.inputDraft, typed);
    assert.equal(waiting.output.includes('after-reconnect'), false);
    await nativeTerminals.write(terminal, '\r', 'write_with_draft');
    await response.promise;
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.inputDraft, '');
    assert.equal(listed.output.split('after-reconnect').length - 1, 1);
  } finally {
    finish();
    await cancelled?.catch(() => undefined);
    await nativeTerminals.close(terminal);
  }
});

test('Enter queued behind a failed draft save is rejected, and a retry sends only the corrected input', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const held = Promise.withResolvers(), release = Promise.withResolvers(), response = Promise.withResolvers();
  let output = '', holding = false;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('corrected-command')) response.resolve();
  });
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    if (holding && args.command === 'shared_terminal' && args.args.action === 'draft') {
      holding = false;
      held.resolve();
      await release.promise;
      throw new Error('Daemon test connection closed');
    }
    return daemon.invoke(args.command, args.args);
  });
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  const stale = "printf '%s%s\\n' 'stale-' 'command'";
  const corrected = "printf '%s%s\\n' 'corrected-' 'command'";
  await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
  const work = [];
  try {
    await nativeTerminals.write(terminal, stale, 'draft');
    holding = true;
    work.push(nativeTerminals.write(terminal, corrected, 'draft'));
    await held.promise;
    work.push(nativeTerminals.write(terminal, '\r', 'write_with_draft'));
    release.resolve();
    const [saved, sent] = await Promise.allSettled(work);
    assert.equal(saved.status, 'rejected');
    assert.match(String(saved.reason), /Daemon test connection closed/);
    assert.equal(sent.status, 'rejected');
    assert.match(String(sent.reason), /Daemon test connection closed/);
    await nativeTerminals.write(terminal, corrected, 'draft');
    await nativeTerminals.write(terminal, '\r', 'write_with_draft');
    await response.promise;
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.inputDraft, '');
    assert.equal(listed.output.includes('stale-command'), false);
    assert.equal(listed.output.split('corrected-command').length - 1, 1);
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    await nativeTerminals.close(terminal);
  }
});
