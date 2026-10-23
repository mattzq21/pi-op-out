import { cleanupScope } from './cleanup-scope.mjs';
import assert from 'node:assert/strict';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { installDom, act, untilDom } from './dom.mjs';
import { daemonClient } from './daemon-client.mjs';
import { nativeFileCommand } from './native-file-command.mjs';
import { trackStorage } from './storage-idle.mjs';

export async function appService(t, { keybindings = {}, remotes = [], beforeMount = async () => {} } = {}) {
  t = cleanupScope(t);
  const dom = installDom();
  const storage = trackStorage(indexedDB);
  const requests = new Set();
  let dispose, bridgeLive = false, replyGate, releaseReply;
  const eventErrors = [];
  const settle = async () => { do { await storage.settled(); await act(() => Promise.allSettled([...requests])); } while (requests.size); };
  t.after(async () => {
    releaseReply?.(); dispose?.(); await settle(); bridgeLive = false; storage.restore(); clearMocks();
    delete globalThis.__PIOP_TEST_MODE__; delete globalThis.__PIOP_TEST_HOT__;
    dom.restore();
    assert.deepEqual(eventErrors, []);
  });
  const native = await nativeFileCommand(t, { desktop: true });
  const daemon = await daemonClient(t, (event, payload) => {
    if (!bridgeLive) return;
    const delivery = emit(event, payload); requests.add(delivery);
    void delivery.catch(error => eventErrors.push(error.message)).finally(() => requests.delete(delivery));
  }, { remotes });
  const preferences = (await native.invoke('load_client_settings')).settings ?? { keybindings: (await daemon.invoke('load_app_settings')).keybindings, debugMode: false };
  await native.invoke('save_client_settings', { settings: { ...preferences, keybindings: { ...preferences.keybindings, ...keybindings } }, baseline: preferences });
  await beforeMount({ daemon, native });
  mockWindows('main');
  mockIPC(async (command, args) => {
    const request = command === 'daemon_invoke' ? daemon.invoke(args.command, args.args) : native.invoke(command, args);
    requests.add(request);
    try { const result = await request; if (replyGate) { replyGate.received.resolve(); await replyGate.release.promise; } return result; } catch (error) { throw new Error(command + ': ' + error.message); } finally { requests.delete(request); }
  }, { shouldMockEvents: true });
  bridgeLive = true;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  globalThis.__PIOP_TEST_MODE__ = 'development';
  globalThis.__PIOP_TEST_HOT__ = { on() {}, off() {}, dispose(callback) { dispose = callback; } };
  await import(`../clients/ui/main.tsx?app-keyboard=${crypto.randomUUID()}`);
  let editor;
  try { editor = await untilDom(() => root.querySelector('[aria-label="Message piop"]'), 15000); }
  catch (error) { throw new Error(error.message + '\n' + root.textContent); }
  await settle();
  return { root, editor, settle, daemon, native, async remount() {
    await act(() => window.dispatchEvent(new Event('pagehide')));
    await settle();
    dispose();
    await settle();
    await import(`../clients/ui/main.tsx?app-remount=${crypto.randomUUID()}`);
    await untilDom(() => root.querySelector('[aria-label="Message piop"]'), 15000);
    await settle();
  }, pauseReplies() {
    replyGate = { received: Promise.withResolvers(), release: Promise.withResolvers() };
    const gate = replyGate;
    releaseReply = () => gate.release.resolve();
    return { received: gate.received.promise, release: releaseReply };
  } };
}
