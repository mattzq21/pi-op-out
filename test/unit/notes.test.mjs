import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderHook } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { useNotes } from '../../src/lib/notes.ts';

test('unsaved notes recover only on the host where they were written', async () => {
  const dom = installDom();
  const opened = [];
  mockIPC((_command, args) => {
    if (args.action === 'list') return { root: '/vault', paths: ['note.md'] };
    if (args.action === 'read') return { path: 'note.md', content: 'original', version: 'same-content-hash' };
    throw new Error('offline');
  });
  try {
    const first = await renderHook(() => useNotes('host-a')); opened.push(first);
    await first.current.openVault('/vault');
    first.current.edit('private draft from A');
    await first.unmount(); opened.pop();
    const second = await renderHook(() => useNotes('host-b')); opened.push(second);
    await second.current.openVault('/vault');
    assert.equal(second.current.content(), 'original');
    const returning = await renderHook(() => useNotes('host-a')); opened.push(returning);
    await returning.current.openVault('/vault');
    assert.equal(returning.current.content(), 'private draft from A');
  } finally { for (const view of opened) await view.unmount(); dom.restore(); }
});
