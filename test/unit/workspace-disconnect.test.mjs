import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook } from '../dom.mjs';
import { useWorkspaceDisconnect } from '../../src/appTransportActivation.ts';

test('disconnect guards unsent drafts and exposes cleanup completion before socket closure', async t => {
  const dom = installDom();
  let accept = false, finished = false, release;
  const calls = [];
  const gate = new Promise(resolve => { release = resolve; });
  const pool = { disconnectAll: async strict => { calls.push(strict); await gate; finished = true; } };
  t.mock.method(window, 'confirm', () => accept);
  const view = await renderHook(() => useWorkspaceDisconnect(() => true, () => pool, () => [], () => ({})));
  t.after(async () => { await view.unmount(); dom.restore(); });
  const tasks = [];
  const request = () => window.dispatchEvent(new CustomEvent('piop-mobile-before-disconnect', { cancelable: true, detail: { waitUntil: task => tasks.push(task) } }));
  assert.equal(request(), false);
  assert.deepEqual(calls, []);
  accept = true;
  assert.equal(request(), true);
  assert.equal(tasks.length, 1);
  await Promise.resolve();
  assert.deepEqual(calls, [true]);
  assert.equal(finished, false);
  release();
  await Promise.all(tasks);
  assert.equal(finished, true);
});
