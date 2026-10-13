import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { mockIPC as mockNativeIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

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
  mockWindows('main');
  mockNativeIPC(() => { throw 'Host is busy; try again'; });
  const client = new NativeTransport({ hostId: 'local' });
  await assert.rejects(client.homeDirectory('local'), reason => String(reason).includes('Host is busy; try again'));
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
