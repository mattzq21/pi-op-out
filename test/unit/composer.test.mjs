import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { Composer } from '../../src/components/Composer.tsx';
import { mockIPC, mockWindows, clearMocks } from '../mock-ipc.mjs';
import { emit } from '@tauri-apps/api/event';

describe('composer interactions', () => {
  let dom, view, props, sent, globals;
  beforeEach(() => {
    dom = installDom(); HTMLElement.prototype.scrollIntoView = () => {};
    sent = []; globals = new Map();
    props = { streaming: false, queued: 0, commands: [], agents: [], models: [], model: null, thinkingLevel: 'off', thinkingLevels: ['off', 'high'], onSend: async (...args) => { sent.push(args); }, onPause: async () => {}, onResume: async () => {}, onAbort: async () => {}, onAgent: () => {}, onModel: () => {}, onThinking: () => {}, onToggleFastMode: async () => {} };
  });
  afterEach(async () => {
    if (view) await view.unmount(); view = undefined;
    clearMocks();
    for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    dom.restore();
  });
  function global(name, value) { globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
  async function render(extra = {}) { props = { ...props, ...extra }; if (view) await view.rerender(props); else view = await renderComponent(Composer, props); }
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const editor = () => control('Message piop');
  const click = async element => act(async () => element.click());
  const key = async (key, extra = {}, element = editor()) => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); await act(async () => element.dispatchEvent(event)); return event; };
  const paste = async files => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files, items: [], getData: () => files.length ? '' : 'plain text' } }); await act(async () => editor().dispatchEvent(event)); return event; };
  const drag = async (type, data = {}, target = document.querySelector('.composer')) => {
    const transfer = { types: ['Files'], files: [], getData: () => '', ...data };
    const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer });
    await act(async () => target.dispatchEvent(event)); return { event, transfer };
  };

  test('submission trims text, ignores blank and composed input, and respects newline and delivery shortcuts', async () => {
    await render(); assert.equal(control('Send message').disabled, true);
    await enterText(editor(), '  '); await key('Enter'); assert.deepEqual(sent, []);
    await enterText(editor(), '  Build it  ');
    assert.equal((await key('Enter', { shiftKey: true })).defaultPrevented, false);
    await key('Enter', { isComposing: true }); assert.deepEqual(sent, []);
    await key('Enter'); assert.deepEqual(sent, [['Build it', undefined, []]]); assert.equal(editor().value, '');
    await render({ streaming: true, queued: 2 });
    await enterText(editor(), 'Steer now'); await key('Enter', { ctrlKey: true });
    await enterText(editor(), 'Next turn'); await key('Enter');
    assert.deepEqual(sent.slice(1), [['Steer now', 'steer', []], ['Next turn', 'followUp', []]]);
    assert.match(document.querySelector('.stream-status').textContent, /2 queued/);
  });

  test('a streaming draft has a clickable follow-up send action', async () => {
    await render({ streaming: true });
    await enterText(editor(), 'After this turn');
    assert.ok(control('Send message'));
    await click(control('Send message'));
    assert.deepEqual(sent, [['After this turn', 'followUp', []]]);
    assert.ok(control('Pause piop'));
  });

  test('in-flight submission is deduplicated and failed sends preserve newer typing', async () => {
    const pending = Promise.withResolvers();
    await render({ onSend: (...args) => { sent.push(args); return pending.promise; } });
    await enterText(editor(), 'Original'); await key('Enter');
    assert.equal(control('Send message').disabled, true); assert.equal(editor().value, '');
    await enterText(editor(), 'New thought'); await key('Enter'); assert.equal(sent.length, 1);
    await act(async () => pending.reject(new Error('connection lost')));
    assert.equal(editor().value, 'Original\n\nNew thought'); assert.equal(document.querySelector('[role=alert]').textContent, 'connection lost');
    await render({ onSend: async () => false }); await click(control('Send message'));
    assert.equal(editor().value, 'Original\n\nNew thought'); assert.equal(document.querySelector('[role=alert]').textContent, 'Message was not submitted');
  });

  test('command and skill palettes support keyboard navigation, dismissal and expansion on send', async () => {
    await render({ commands: [{ name: 'clear', source: 'extension', description: 'Clear context' }, { name: 'compact', source: 'extension' }, { name: 'skill:Research', source: 'skill' }] });
    await enterText(editor(), '/c'); assert.equal(control('piop commands').querySelectorAll('[role=option]').length, 3);
    await key('ArrowUp'); assert.equal(document.querySelector('[aria-selected=true]').textContent, '/skill:Research');
    await key('ArrowDown'); await key('ArrowDown'); await key('Tab'); assert.equal(editor().value, '/compact '); assert.equal(control('piop commands'), null);
    await key('Enter'); assert.deepEqual(sent[0], ['/compact', undefined, []]);
    await enterText(editor(), 'Please $res'); await key('Enter'); assert.equal(editor().value, 'Please $Research ');
    await key('Enter'); assert.deepEqual(sent[1], ['/skill:Research Please', undefined, []]);
    await enterText(editor(), '/'); await key('Escape'); assert.equal(control('piop commands'), null);
    await enterText(editor(), '/cl'); assert.ok(control('piop commands'));
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))); assert.equal(control('piop commands'), null);
  });

  test('pause, stop and resume serialize pending actions and expose failures', async () => {
    const pending = Promise.withResolvers(); let pauses = 0, stops = 0, resumes = 0;
    await render({ streaming: true, onPause: () => { pauses++; return pending.promise; }, onAbort: async () => { stops++; throw 'cannot stop'; } });
    await act(async () => { control('Pause piop').click(); control('Pause piop').click(); }); assert.equal(pauses, 1);
    assert.match(document.querySelector('.stream-status').textContent, /Pausing/);
    await enterText(editor(), 'Hold'); await key('Enter'); assert.deepEqual(sent, []);
    await click(control('Stop piop')); assert.equal(stops, 1); assert.equal(document.querySelector('[role=alert]').textContent, 'cannot stop');
    await act(async () => pending.reject(new Error('cannot pause'))); assert.equal(document.querySelector('[role=alert]').textContent, 'cannot pause');
    const resuming = Promise.withResolvers();
    await enterText(editor(), '');
    await render({ streaming: false, paused: true, onResume: () => { resumes++; return resuming.promise; } });
    await click(control('Resume piop')); assert.equal(control('Stop piop').disabled, true); assert.match(document.querySelector('.stream-status').textContent, /Resuming/);
    await act(async () => resuming.resolve()); assert.equal(resumes, 1); assert.equal(control('Resume piop').disabled, false);
    await render({ controlsDisabled: true }); assert.equal(editor().disabled, true); assert.equal(control('Resume piop').disabled, true);
  });

  test('model, agent and thinking pickers return selected values and restore trigger focus', async () => {
    const choices = []; const model = { provider: 'provider', id: 'gpt-small', name: 'gpt-Small' };
    await render({ models: [model], agents: [{ name: 'default' }, { name: 'review' }], onAgent: value => choices.push(value), onModel: value => choices.push(value), onThinking: value => choices.push(value) });
    await click(control('Agent')); await dom.flushFrames(); assert.equal(document.activeElement.dataset.value, 'default');
    await key('ArrowUp', {}, document.activeElement); assert.equal(document.activeElement.dataset.value, 'review');
    await click(document.activeElement); assert.deepEqual(choices, ['review']); assert.equal(document.activeElement, control('Agent'));
    await click(control('Model')); await click(document.querySelector('[role=option]')); assert.equal(choices[1], model);
    await click(control('Thinking level')); await click(document.querySelector('[role=option][data-value=high]')); assert.equal(choices[2], 'high');
    await click(control('Agent')); await key('Escape', {}, control('Agent')); assert.equal(control('Agent options'), null);
    await click(control('Model')); await render({ controlsDisabled: true }); assert.equal(control('Model options'), null); assert.equal(control('Model').disabled, true);
  });

  test('empty picker menus and outside or resize dismissal leave selection unchanged', async () => {
    await render(); await click(control('Model')); assert.match(control('Model options').textContent, /No options available/);
    await key('ArrowDown', {}, control('Model'));
    await act(async () => window.dispatchEvent(new Event('resize'))); assert.equal(control('Model options'), null);
    await click(control('Agent')); await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))); assert.equal(control('Agent options'), null);
    await click(control('Agent')); await click(control('Agent')); assert.equal(control('Agent options'), null);
  });

  test('fast mode prevents repeated requests and reports failures while preserving server state', async () => {
    const pending = Promise.withResolvers(); let toggles = 0;
    await render(); assert.equal(control('Fast mode'), null);
    await render({ fastModeStatus: 'Fast mode off', onToggleFastMode: () => { toggles++; return pending.promise; } });
    await act(async () => { control('Fast mode').click(); control('Fast mode').click(); }); assert.equal(toggles, 1); assert.equal(control('Fast mode').getAttribute('aria-busy'), 'true');
    await act(async () => pending.reject(new Error('offline'))); assert.equal(document.querySelector('[role=alert]').textContent, 'Could not toggle Fast mode: offline'); assert.equal(control('Fast mode').getAttribute('aria-pressed'), 'false');
    await render({ fastModeStatus: 'Fast mode on', onToggleFastMode: async () => {} }); await click(control('Fast mode')); assert.equal(document.querySelector('[role=alert]'), null); assert.equal(control('Fast mode').getAttribute('aria-pressed'), 'true');
  });

  test('restored drafts apply once without replacing user edits and explicit focus requests focus the editor', async () => {
    await render({ restoredDraft: { id: 'a', value: 'Restore me' } }); assert.equal(editor().value, 'Restore me');
    await enterText(editor(), 'Edited'); await render({ restoredDraft: { id: 'b', value: 'Other text' } }); assert.equal(editor().value, 'Edited');
    await enterText(editor(), ''); await render({ restoredDraft: { id: 'b', value: 'Other text' } }); assert.equal(editor().value, '');
    await render({ restoredDraft: { id: 'c', value: 'Fresh' } }); assert.equal(editor().value, 'Fresh');
    editor().blur(); await render({ focusRequest: 1 }); await dom.flushFrames(); assert.equal(document.activeElement, editor());
  });

  test('context indicators clamp percentages and describe unavailable usage', async () => {
    let terminals = 0;
    await render({ contextUsage: { tokens: 50, contextWindow: 200 }, onOpenTerminal: () => terminals++, sessionCache: { rate: 20, low: true } });
    assert.ok(control('25% of 200 context tokens used')); assert.match(document.querySelector('.session-cache-hit.low').textContent, /20%/); await click(control('Open terminal')); assert.equal(terminals, 1);
    await render({ contextUsage: { tokens: null, contextWindow: 200 } }); assert.ok(control('Context usage unavailable; window is 200 tokens'));
    for (const [percent, expected] of [[-3, 0], [130, 100]]) { await render({ contextUsage: { percent, tokens: 50, contextWindow: 200 } }); assert.ok(control(`${expected}% of 200 context tokens used`)); }
  });

  test('text attachments retain their contents, escape filenames, and can be removed before sending', async () => {
    await render(); assert.equal((await paste([])).defaultPrevented, false);
    await paste([new File(['const value = 1;'], 'a&"<>\'.ts'), new File(['discard'], 'remove.txt')]);
    assert.equal(document.querySelectorAll('.attachments b').length, 2);
    await click(control('Remove remove.txt')); assert.equal(document.querySelectorAll('.attachments b').length, 1);
    await enterText(editor(), 'Review'); await key('Enter');
    assert.deepEqual(sent, [['Review\n\n<file name="a&amp;&quot;&lt;&gt;&apos;.ts">\nconst value = 1;\n</file>', undefined, []]]);
    assert.equal(document.querySelector('.attachments'), null);
  });

  test('unsupported, oversized and corrupt text attachments are rejected without discarding valid files', async () => {
    await render();
    await paste([new File(['x'], 'program.exe'), new File([new Uint8Array(200001)], 'huge.txt'), new File([new Uint8Array([255])], 'encoding.txt'), new File(['a\0b'], 'binary.txt'), new File(['ok'], 'good.json')]);
    const error = document.querySelector('[role=alert]').textContent;
    assert.match(error, /program.exe is not a supported text file/); assert.match(error, /huge.txt is larger than 200 KB/);
    assert.match(error, /encoding.txt does not contain valid UTF-8/); assert.match(error, /binary.txt does not contain valid text/);
    assert.equal(document.querySelector('.attachments b').textContent, 'good.json');
    await click(control('Remove good.json')); assert.equal(document.querySelector('[role=alert]'), null);
    await render({ controlsDisabled: true }); await paste([new File(['ignored'], 'disabled.txt')]); assert.equal(document.querySelector('.attachments'), null);
  });

  test('attachment limits reject excess files and unsupported images explain model requirements', async () => {
    await render(); await paste([new File(['x'], 'photo.PNG')]); assert.ok(control('Dismiss image input error'));
    await click(control('Dismiss image input error')); assert.equal(document.querySelector('[role=alert]'), null);
    await render({ model: { id: 'vision', provider: 'p', input: ['image'] } });
    await paste([new File(['x'], 'vector.svg', { type: 'image/svg+xml' }), new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }), new File([new Uint8Array(24 * 1024 * 1024 + 1)], 'huge.txt')]);
    assert.match(document.querySelector('[role=alert]').textContent, /unsupported image format.*larger than 10 MB.*24 MB attachment limit/);
    await paste(Array.from({ length: 13 }, (_, i) => new File(['text'], `${i}.txt`)));
    assert.equal(document.querySelectorAll('.attachments b').length, 12); assert.match(document.querySelector('[role=alert]').textContent, /Only 12 attachments/);
  });

  test('failed submission restores attachments and image-only submissions require a capable model', async () => {
    await render({ onSend: async () => { throw new Error('offline'); } }); await paste([new File(['body'], 'note.txt')]); await key('Enter');
    assert.equal(document.querySelector('.attachments b').textContent, 'note.txt'); assert.equal(document.querySelector('[role=alert]').textContent, 'offline');
    const image = { type: 'image', mimeType: 'image/png', data: 'aA==' };
    await render({ uploads: [{ id: 'image', kind: 'image', name: 'photo.png', byteSize: 1, image }], onSend: props.onSend }); await key('Enter'); assert.ok(control('Dismiss image input error'));
    await render({ model: { id: 'vision', provider: 'p' }, models: [{ id: 'vision', provider: 'p', input: ['image'] }], onSend: async (...args) => sent.push(args) });
    assert.equal(control('Dismiss image input error'), null); await key('Enter'); assert.deepEqual(sent, [['', undefined, [image]]]);
  });

  test('queued messages enforce ordering boundaries, change delivery, and recover from action failures', async () => {
    const changes = [], pending = Promise.withResolvers();
    await render({ pendingMessages: [{ id: 'a', message: 'First', behavior: 'followUp' }, { id: 'b', message: 'Second', behavior: 'followUp' }, { id: 'c', message: 'Retry me', behavior: 'steer', retry: true }], onChangePending: (id, action) => { changes.push([id, action]); return pending.promise; } });
    assert.equal(control('Move queued message up: First').disabled, true); assert.equal(control('Move queued message down: Second').disabled, true); assert.equal(control('Drag to reorder queued message: Retry me').disabled, true);
    await click(control('Move queued message down: First')); assert.deepEqual(changes, [['a', 'moveDown']]); assert.equal(control('Remove queued message: Second').disabled, true);
    await act(async () => pending.reject(new Error('queue changed'))); assert.equal(document.querySelector('[role=alert]').textContent, 'queue changed');
    await render({ onChangePending: async (id, action) => changes.push([id, action]) });
    await key('ArrowUp', {}, control('Drag to reorder queued message: Second'));
    await click(document.querySelector('[data-pending-id=a] .pending-message-actions > button'));
    await click(document.querySelector('[data-pending-id=c] .pending-message-actions > button'));
    await click(control('Remove queued message: Second'));
    assert.deepEqual(changes.slice(1), [['b', 'moveUp'], ['a', 'steer'], ['c', 'steer'], ['b', 'remove']]); assert.equal(document.querySelector('[role=alert]'), null);
    const text = document.querySelector('.pending-message-text');
    await act(async () => text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); assert.ok(document.querySelector('.pending-message.expanded'));
    await act(async () => text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); assert.equal(document.querySelector('.pending-message.expanded'), null);
  });


  test('file drag previews survive nested enters and clear on leave, drop or window blur', async () => {
    await render();
    assert.equal((await drag('dragenter', { types: ['text/plain'] })).event.defaultPrevented, false);
    await drag('dragenter'); await drag('dragenter'); assert.ok(document.querySelector('.composer-drop-hint'));
    await drag('dragleave'); assert.ok(document.querySelector('.composer-drop-hint'));
    await drag('dragleave'); assert.equal(document.querySelector('.composer-drop-hint'), null);
    assert.equal((await drag('dragover')).transfer.dropEffect, 'copy');
    await drag('dragenter'); await act(async () => window.dispatchEvent(new Event('blur'))); assert.equal(document.querySelector('.composer-drop-hint'), null);
    await drag('dragenter'); await drag('drop', { files: [new File(['dropped text'], 'drop.txt')] });
    assert.equal(document.querySelector('.attachments b').textContent, 'drop.txt'); assert.equal(document.querySelector('.composer-drop-hint'), null); assert.equal(document.activeElement, editor());
    await render({ controlsDisabled: true }); assert.equal((await drag('dragover')).transfer.dropEffect, 'none');
    await drag('drop', { files: [new File(['ignored'], 'ignored.txt')] }); assert.equal(document.querySelectorAll('.attachments b').length, 1);
    assert.equal((await drag('drop', {}, window)).event.defaultPrevented, true);
    assert.equal((await drag('drop', { types: ['text/plain'] })).event.defaultPrevented, false);
  });

  test('concurrent file reads respect the attachment count after earlier reads finish', async () => {
    await render();
    const pending = Promise.withResolvers();
    const slow = new File(['slow'], 'slow.txt'); slow.arrayBuffer = () => pending.promise;
    await paste([slow]);
    await paste(Array.from({ length: 12 }, (_, i) => new File(['fast'], `fast${i}.txt`)));
    await act(async () => pending.resolve(new TextEncoder().encode('slow').buffer));
    assert.equal(document.querySelectorAll('.attachments b').length, 12); assert.equal(control('Remove slow.txt'), null);
    assert.match(document.querySelector('[role=alert]').textContent, /Only 12 attachments/);
  });

  test('image decoding validates attachments and a model switch during decoding prevents acceptance', async () => {
    const decoded = [], pending = Promise.withResolvers(); let decodeResult;
    global('FileReader', class {
      readAsDataURL(file) { file.arrayBuffer().then(buffer => { this.result = `data:${file.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onload(); }); }
    });
    global('Image', class { decode() { decoded.push(this.src); return decodeResult; } });
    await render({ model: { id: 'v', provider: 'p', input: ['image'] } });
    await paste([new File(['bytes'], 'image.png', { type: 'image/png' })]);
    assert.deepEqual(decoded, ['data:image/png;base64,Ynl0ZXM=']); assert.ok(control('Remove image.png'));
    await key('Enter'); assert.equal(sent[0][2][0].data, 'Ynl0ZXM='); assert.equal(sent[0][2][0].mimeType, 'image/png');
    decodeResult = Promise.reject(new Error('invalid')); decodeResult.catch(() => {});
    await paste([new File(['broken'], 'bad.png', { type: 'image/png' })]); assert.match(document.querySelector('[role=alert]').textContent, /bad.png is not a valid image/);
    decodeResult = pending.promise;
    await paste([new File(['slow'], 'slow.png', { type: 'image/png' })]);
    await render({ model: { id: 'text', provider: 'p', input: ['text'] } });
    await act(async () => pending.resolve()); assert.equal(control('Remove slow.png'), null); assert.ok(control('Dismiss image input error'));
  });

  test('native file drops use scaled bounds, reject outside positions and clean up subscriptions', async () => {
    global('isTauri', true); const reads = [];
    mockWindows('main'); mockIPC(async (command, args) => { assert.equal(command, 'read_dropped_file'); reads.push(args.path); if (args.path === '/bad') throw new Error('unreadable'); return { name: 'native.txt', data: [111, 107] }; }, { shouldMockEvents: true });
    await render();
    Object.defineProperty(window, 'devicePixelRatio', { value: 2 });
    document.querySelector('.composer').getBoundingClientRect = () => ({ left: 10, top: 10, right: 100, bottom: 100 });
    const native = async (event, payload) => act(async () => emit(`tauri://drag-${event}`, payload));
    await native('enter', { paths: ['/ok'], position: { x: 100, y: 100 } }); assert.ok(document.querySelector('.composer-drop-hint'));
    await native('leave', {}); assert.equal(document.querySelector('.composer-drop-hint'), null);
    await native('drop', { paths: ['/outside'], position: { x: 300, y: 300 } }); assert.deepEqual(reads, []);
    await native('drop', { paths: ['/bad', '/ok'], position: { x: 100, y: 100 } });
    assert.deepEqual(reads, ['/bad', '/ok']); assert.ok(control('Remove native.txt')); assert.match(document.querySelector('[role=alert]').textContent, /unreadable/);
    await render({ controlsDisabled: true }); await native('drop', { paths: ['/disabled'], position: { x: 100, y: 100 } }); assert.equal(reads.length, 2);
    await view.unmount(); view = undefined;
    await native('drop', { paths: ['/unmounted'], position: { x: 100, y: 100 } }); assert.equal(reads.length, 2);
  });

  test('URI drops read only local file URLs and cap native file batches', async () => {
    const reads = [];
    mockIPC(async (command, args) => { assert.equal(command, 'read_dropped_file'); reads.push(args.path); return { name: `${reads.length}.txt`, data: [120] }; });
    await render();
    await drag('drop', { getData: () => '#comment\nhttps://example.com/file\nfile://remote/secret\nfile:///local%20file\nfile://localhost/second\nfile:///%ZZ' });
    assert.deepEqual(reads, ['/local file', '/second']); assert.equal(document.querySelectorAll('.attachments b').length, 2);
    await drag('drop', { getData: () => Array.from({ length: 14 }, (_, i) => `file:///file${i}`).join('\n') });
    assert.equal(reads.length, 14); assert.equal(document.querySelectorAll('.attachments b').length, 12); assert.match(document.querySelector('[role=alert]').textContent, /extra files were skipped/);
  });
});
