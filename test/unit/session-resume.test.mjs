import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { act, installDom } from '../dom.mjs';
import { useSessionResume, restoredSessionTarget } from '../../clients/ui/lib/sessionResume.ts';

test('a new unsent conversation restores its draft identity and host without opening a nonexistent session file', async () => {
  const dom = installDom();
  let dispose;

  try {
    let setSelection;
    createRoot(stop => {
      dispose = stop;
      const [selection, update] = createSignal({ ready: true, saved: false, target: { hostId: 'remote', cwd: '/project', sessionId: 'unsaved', sessionPath: '/not-yet-created.jsonl', draftKey: 'remote:unsaved' } });
      setSelection = update;
      useSessionResume(selection);
    });
    await act(() => {});
    assert.deepEqual(restoredSessionTarget(), { hostId: 'remote', cwd: '/project', draftKey: 'remote:unsaved' });
    await act(() => setSelection({ ready: true, saved: false, target: { hostId: 'remote' } }));
    assert.deepEqual(restoredSessionTarget(), {});
  } finally { dispose?.(); dom.restore(); }
});

test('saved session restoration ignores unready selections and validates persisted data', async () => {
  const dom = installDom();
  let dispose;

  try {
    let setSelection;
    const target = { cwd: '/project', hostId: 'local', sessionId: 'saved', sessionPath: '/saved.jsonl' };
    createRoot(stop => {
      dispose = stop;
      const [selection, update] = createSignal({ ready: true, saved: true, target });
      setSelection = update;
      useSessionResume(selection);
    });
    await act(() => {});
    assert.deepEqual(restoredSessionTarget(), target);
    await act(() => setSelection({ ready: false, saved: false, target: {} }));
    assert.deepEqual(restoredSessionTarget(), target);
    localStorage.setItem('piop-last-session:desktop:main', '{"draftKey":7,"hostId":"local"}');
    assert.deepEqual(restoredSessionTarget(), {});
  } finally { dispose?.(); dom.restore(); }
});
