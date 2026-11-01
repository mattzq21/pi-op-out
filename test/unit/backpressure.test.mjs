import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { mockIPC as mockNativeIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { clientIdentity } from '../../clients/ui/lib/clientIdentity.ts';

test('desktop daemon requests recover from explicit busy rejections', { timeout: 10000 }, async context => {
  const dom = installDom();
  context.after(() => { clearMocks(); dom.restore(); });
  await clientIdentity('desktop');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const home = '/home/test-user';
  mockWindows('main');
  const busyReplies = ['Host is busy; try again', 'Host is busy; try again'];
  mockNativeIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    assert.equal(args.command, 'home_directory');
    assert.equal(args.args.hostId, 'local');
    const busy = busyReplies.shift();
    if (busy) throw busy;
    return home;
  });
  const client = new NativeTransport({ hostId: 'local' });
  const result = client.homeDirectory('local').then(value => ({ value }), error => ({ error }));
  for (let retry = 0; retry < 2; retry++) {
    await new Promise(setImmediate);
    context.mock.timers.runAll();
  }
  assert.deepEqual(await result, { value: home });
});

test('desktop requests report persistent saturation instead of retrying forever', { timeout: 10000 }, async context => {
  const dom = installDom();
  context.after(() => { clearMocks(); dom.restore(); });
  await clientIdentity('desktop');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  mockWindows('main');
  let attempts = 0;
  mockNativeIPC(() => { attempts++; throw 'Host is busy; try again'; });
  const client = new NativeTransport({ hostId: 'local' });
  const result = assert.rejects(client.homeDirectory('local'), reason => String(reason).includes('Host is busy; try again'));
  await new Promise(setImmediate);
  assert.equal(attempts, 1);
  for (const [index, delay] of [100, 200, 400, 800, 1000, 1000].entries()) {
    context.mock.timers.tick(delay - 1);
    await new Promise(setImmediate);
    assert.equal(attempts, index + 1, 'does not retry before the delay');
    context.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(attempts, index + 2);
  }
  await result;
  context.mock.timers.tick(10000);
  await new Promise(setImmediate);
  assert.equal(attempts, 7, 'does not retry after reporting failure');
});

test('a terminal command with an uncertain result is not sent again', async context => {
  const dom = installDom();
  context.after(() => { clearMocks(); dom.restore(); });
  mockWindows('main');
  const terminalInput = [];
  mockNativeIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    assert.equal(args.command, 'shared_terminal');
    terminalInput.push(args.args.data);
    throw 'Timed out; the command may have completed';
  });
  const client = new NativeTransport({ hostId: 'local' });
  await assert.rejects(client.writeTerminal(crypto.randomUUID(), 'one command\r'), reason => /may have completed/.test(String(reason)));
  assert.equal(terminalInput.join(''), 'one command\r');
});
