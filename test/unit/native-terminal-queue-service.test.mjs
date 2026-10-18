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

test('a connection change on one remote machine cancels only its queued Enter, and local queued Enter is sent once', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const localTerminal = crypto.randomUUID(), remoteTerminal = crypto.randomUUID();
  const response = Promise.withResolvers();
  let output = '';
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== localTerminal) return;
    output += payload.data;
    if (output.includes('local-sent')) response.resolve();
  }, { remotes: [{ id: 'remote', name: 'Remote', target: 'remote' }] });
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    return daemon.invoke(args.command, args.args);
  });
  const localChat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const remoteChat = await daemon.invoke('create_temporary_chat', { hostId: 'remote' });
  const localSession = `local:draft-${crypto.randomUUID()}`, remoteSession = `remote:draft-${crypto.randomUUID()}`;
  const localTyped = "printf '%s%s\\n' 'local-' 'sent'", remoteTyped = "printf '%s%s\\n' 'remote-' 'sent'";
  await nativeTerminals.start(localTerminal, localSession, localChat.cwd, 80, 24, 'local');
  await nativeTerminals.start(remoteTerminal, remoteSession, remoteChat.cwd, 80, 24, 'remote');
  await nativeTerminals.write(localTerminal, localTyped, 'draft');
  await nativeTerminals.write(remoteTerminal, remoteTyped, 'draft');
  const finish = beginBranching();
  const work = [];
  try {
    work.push(nativeTerminals.write(remoteTerminal, '\r', 'write_with_draft'));
    work.push(nativeTerminals.write(localTerminal, '\r', 'write_with_draft'));
    nativeTerminals.invalidateWrites('remote');
    finish();
    const [remoteSent, localSent] = await Promise.allSettled(work);
    assert.equal(remoteSent.status, 'rejected');
    assert.match(String(remoteSent.reason), /Terminal connection changed\. Enter the input again\./);
    assert.equal(localSent.status, 'fulfilled');
    await response.promise;
    const [remote] = await nativeTerminals.list(remoteSession, 'remote');
    assert.equal(remote.inputDraft, remoteTyped);
    assert.equal(remote.output.includes('remote-sent'), false);
    const [local] = await nativeTerminals.list(localSession, 'local');
    assert.equal(local.inputDraft, '');
    assert.equal(local.output.split('local-sent').length - 1, 1);
  } finally {
    finish();
    await Promise.allSettled(work);
    await Promise.all([nativeTerminals.close(localTerminal), nativeTerminals.close(remoteTerminal)]);
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

test('Ctrl+C reaches the shell while a draft save is held, and the old draft does not come back', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const terminal = crypto.randomUUID();
  const held = Promise.withResolvers(), release = Promise.withResolvers(), waiting = Promise.withResolvers(), interrupted = Promise.withResolvers();
  let output = '', holding = false;
  const daemon = await daemonClient(t, (event, payload) => {
    if (event !== 'pi://event' || payload.type !== 'terminal_output' || payload.terminalId !== terminal) return;
    output += payload.data;
    if (output.includes('waiting-interrupt')) waiting.resolve();
    if (output.includes('interrupt-seen')) interrupted.resolve();
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
  const within = (promise, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 5000); })]).finally(() => clearTimeout(timer));
  };
  const chat = await daemon.invoke('create_temporary_chat');
  const session = `local:draft-${crypto.randomUUID()}`;
  const program = "sh -c 'trap \"printf %s%s\\\\n interrupt- seen; exit 0\" INT; printf %s%s\\\\n waiting- interrupt; while :; do sleep 1; done'";
  await nativeTerminals.start(terminal, session, chat.cwd, 80, 24, 'local');
  const work = [];
  try {
    await nativeTerminals.write(terminal, program + '\r', 'write');
    await within(waiting.promise, 'program start');
    holding = true;
    work.push(nativeTerminals.write(terminal, 'old draft', 'draft'));
    await within(held.promise, 'held draft save');
    work.push(nativeTerminals.interrupt(terminal));
    await within(interrupted.promise, 'Ctrl+C while the draft save is held');
    release.resolve();
    const results = await within(Promise.allSettled(work), 'queued work');
    assert.deepEqual(results.map(result => result.status === 'rejected' ? String(result.reason) : result.status), ['fulfilled', 'fulfilled']);
    const [listed] = await nativeTerminals.list(session, 'local');
    assert.equal(listed.inputDraft, '');
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    await nativeTerminals.close(terminal);
  }
});
