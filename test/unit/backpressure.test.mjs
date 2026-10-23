import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { mockIPC as mockNativeIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { clientIdentity } from '../../clients/ui/lib/clientIdentity.ts';

test('desktop daemon requests recover from explicit busy rejections', async context => {
  const dom = installDom();
  context.after(() => { clearMocks(); dom.restore(); });
  const daemon = await daemonClient(context);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  mockWindows('main');
  const busyReplies = ['Host is busy; try again', 'Host is busy; try again'];
  mockNativeIPC((command, args) => {
    assert.equal(command, 'daemon_invoke');
    const busy = busyReplies.shift();
    if (busy) throw busy;
    return daemon.invoke(args.command, args.args);
  });
  const client = new NativeTransport({ hostId: 'local' });
  assert.equal(await client.homeDirectory('local'), home);
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
