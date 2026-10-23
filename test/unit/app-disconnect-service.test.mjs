import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enterText, act } from '../dom.mjs';
import { appService } from '../app-service-fixture.mjs';

test('disconnect confirmation and cleanup', { timeout: 60000 }, async t => {
  const { editor, settle, pauseReplies, daemon } = await appService(t);
  await t.test('declining disconnect preserves an unsent draft and keeps the workspace usable', { timeout: 30000 }, async t => {
    await enterText(editor, 'Do not lose this draft');
    await settle();
    const confirmations = [];
    t.mock.method(window, 'confirm', message => { confirmations.push(message); return false; });
    const tasks = [];
    const allowed = window.dispatchEvent(new CustomEvent('piop-mobile-before-disconnect', { cancelable: true, detail: { waitUntil: task => tasks.push(task) } }));
    assert.equal(allowed, false);
    assert.deepEqual(confirmations, ['Disconnect? Draft messages, interrupted messages, attachments, and unsaved settings will be discarded.']);
    assert.deepEqual(tasks, []);
    assert.equal(editor.value, 'Do not lose this draft');
    await enterText(editor, 'Still editable');
    assert.equal(editor.value, 'Still editable');
    assert.equal(typeof await daemon.invoke('home_directory', { hostId: 'local' }), 'string');
  });


  await t.test('accepted disconnect waits for the real service cleanup reply', { timeout: 30000 }, async t => {
    await enterText(editor, 'A draft to discard');
    await settle();
    t.mock.method(window, 'confirm', () => true);
    const gate = pauseReplies();
    const tasks = [];
    const allowed = window.dispatchEvent(new CustomEvent('piop-mobile-before-disconnect', { cancelable: true, detail: { waitUntil: task => tasks.push(task) } }));
    assert.equal(allowed, true);
    assert.equal(tasks.length, 1);
    let finished = false;
    const completion = Promise.all(tasks).then(() => { finished = true; });
    await gate.received;
    await act(() => {});
    assert.equal(finished, false);
    gate.release();
    await completion;
    assert.equal(finished, true);
    assert.equal(typeof await daemon.invoke('home_directory', { hostId: 'local' }), 'string');
  });
});
