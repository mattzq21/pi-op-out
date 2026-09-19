import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderHook, act } from '../dom.mjs';
import { installTextEditingShortcuts } from '../../src/lib/textEditingShortcuts.ts';
import { usePendingMessageDrag } from '../../src/lib/usePendingMessageDrag.ts';
import { useSessionGroups, isTemporaryChatCwd } from '../../src/lib/sessionGroups.ts';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';

describe('native text editing shortcuts', () => {
  let dom, remove, commands;
  beforeEach(() => { dom = installDom(); commands = []; document.execCommand = command => commands.push(command); remove = installTextEditingShortcuts(); });
  afterEach(() => { remove(); dom.restore(); });
  function field(tag = 'input', properties = {}) { const node = document.createElement(tag); Object.assign(node, properties); document.body.append(node); node.focus(); return node; }
  function press(target, key, modifiers = {}) { const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...modifiers }); target.dispatchEvent(event); return event; }

  test('undo and both redo bindings delegate to the browser and stop application shortcuts', () => {
    const input = field(); let propagated = 0; window.addEventListener('keydown', () => propagated++);
    assert.equal(press(input, 'z').defaultPrevented, true);
    press(input, 'Z', { ctrlKey: false, metaKey: true, shiftKey: true }); press(input, 'y');
    assert.deepEqual(commands, ['undo', 'redo', 'redo']); assert.equal(propagated, 0);
    remove(); press(input, 'z'); assert.equal(commands.length, 3); assert.equal(propagated, 1);
  });

  test('ordinary typing, composition, alternative modifiers and unrelated keys remain untouched', () => {
    const input = field();
    for (const [key, modifiers] of [['z', { ctrlKey: false }], ['z', { altKey: true }], ['z', { isComposing: true }], ['y', { shiftKey: true }], ['a', {}]]) assert.equal(press(input, key, modifiers).defaultPrevented, false);
    const handled = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }); handled.preventDefault(); input.dispatchEvent(handled);
    assert.deepEqual(commands, []);
  });

  test('readonly, disabled, noneditable and terminal fields keep their own shortcut behavior', () => {
    const readonly = field('textarea', { readOnly: true }); assert.equal(press(readonly, 'z').defaultPrevented, false);
    const disabled = field(); disabled.disabled = true; assert.equal(press(disabled, 'z').defaultPrevented, false);
    const checkbox = field('input', { type: 'checkbox' }); assert.equal(press(checkbox, 'z').defaultPrevented, false);
    const button = field('button'); assert.equal(press(button, 'z').defaultPrevented, false);
    const terminal = document.createElement('div'); terminal.className = 'xterm'; document.body.append(terminal);
    const input = document.createElement('textarea'); terminal.append(input); input.focus(); assert.equal(press(input, 'z').defaultPrevented, false);
    assert.deepEqual(commands, []);
  });

  test('text areas and contenteditable fields use the same undo path', () => {
    press(field('textarea'), 'z');
    const editable = field('div', { tabIndex: 0 }); Object.defineProperty(editable, 'isContentEditable', { value: true });
    press(editable, 'z'); assert.deepEqual(commands, ['undo', 'undo']);
  });
});

describe('pending-message dragging', () => {
  let dom, hook, queue, handle, moves, messages;
  beforeEach(async () => {
    dom = installDom(); moves = [];
    messages = [{ id: 'a', behavior: 'steer' }, { id: 'b', behavior: 'steer' }, { id: 'c', behavior: 'steer' }, { id: 'other', behavior: 'followUp' }, { id: 'retry', behavior: 'steer', retry: true }];
    queue = document.createElement('div'); queue.className = 'pending-messages'; document.body.append(queue);
    queue.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 200 });
    messages.forEach((message, index) => { const row = document.createElement('div'); row.dataset.pendingId = message.id; row.getBoundingClientRect = () => ({ top: index * 30, height: 30 }); queue.append(row); });
    handle = document.createElement('button'); queue.firstChild.append(handle);
    hook = await renderHook(props => usePendingMessageDrag(props.messages, props.disabled, (...args) => moves.push(args)), { messages, disabled: false });
  });
  afterEach(async () => { await hook.unmount(); dom.restore(); });
  const begin = async (id = 'a', extra = {}) => act(async () => hook.current.begin({ button: 0, pointerId: 1, clientX: 100, clientY: 15, currentTarget: handle, preventDefault() {}, ...extra }, id));
  const pointer = async (type, x, y, pointerId = 1) => act(async () => { const event = new Event(type, { cancelable: true }); Object.assign(event, { pointerId, clientX: x, clientY: y }); window.dispatchEvent(event); });

  test('dragging below peers moves within the same queue and releases capture', async () => {
    await begin(); await pointer('pointermove', 100, 90);
    assert.deepEqual(hook.current.drop, { id: 'a', targetId: 'c', edge: 'after' });
    await pointer('pointerup', 100, 90);
    assert.deepEqual(moves, [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
    assert.equal(handle.hasPointerCapture(1), false); assert.equal(dom.frames.size, 0); assert.equal(hook.current.drop, undefined);
  });

  test('dragging upwards uses row midpoints, filters retries and avoids no-op moves', async () => {
    await begin('c'); await pointer('pointermove', 100, 0); await pointer('pointerup', 100, 0);
    assert.deepEqual(moves, [['c', { type: 'move', targetId: 'a', edge: 'before' }]]);
    moves.length = 0;
    await begin(); await pointer('pointermove', 100, 35); await pointer('pointermove', 100, 35); await pointer('pointerup', 100, 35);
    assert.deepEqual(moves, []);
  });

  test('small movements, other pointers, disabled queues and missing sources cannot reorder', async () => {
    await begin('retry'); await begin('missing'); await begin('a', { button: 2 }); assert.equal(dom.frames.size, 0);
    await begin(); await pointer('pointermove', 100, 17); assert.equal(hook.current.drop, undefined);
    await pointer('pointermove', 100, 90, 2); await pointer('pointerup', 100, 90, 2); assert.equal(handle.hasPointerCapture(1), true);
    await pointer('pointerup', 100, 17); assert.deepEqual(moves, []);
    await hook.rerender({ messages, disabled: true }); await begin(); assert.equal(dom.frames.size, 0);
  });

  test('out-of-bounds drops and queues with no eligible peers do not move messages', async () => {
    for (const [x, y] of [[-100, 50], [400, 50], [100, -50], [100, 250]]) {
      await begin(); await pointer('pointermove', x, y); assert.deepEqual(hook.current.drop, { id: 'a' }); await pointer('pointerup', x, y);
    }
    await begin('other'); await pointer('pointermove', 100, 50); await pointer('pointerup', 100, 50);
    assert.deepEqual(moves, []);
  });

  test('escape, cancellation, disabled state and source removal clear listeners and scheduled scrolling', async () => {
    for (const type of ['pointercancel', 'blur']) { await begin(); await act(async () => window.dispatchEvent(new Event(type))); assert.equal(dom.frames.size, 0); }
    await begin(); await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))); assert.equal(handle.hasPointerCapture(1), true);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); assert.equal(handle.hasPointerCapture(1), false);
    await begin(); await hook.rerender({ messages, disabled: true }); assert.equal(dom.frames.size, 0);
    await hook.rerender({ messages, disabled: false }); await begin(); await hook.rerender({ messages: messages.slice(1), disabled: false }); assert.equal(dom.frames.size, 0);
    assert.deepEqual(moves, []);
  });

  test('drag scrolling responds to vertical edges and works without pointer capture support', async () => {
    handle.setPointerCapture = () => { throw new Error('unsupported'); };
    await begin(); await dom.flushFrames(); assert.equal(queue.scrollTop, 0);
    await pointer('pointermove', 100, 190); await dom.flushFrames(); assert.equal(queue.scrollTop, 6);
    await pointer('pointermove', 100, 0); await dom.flushFrames(); assert.equal(queue.scrollTop, 0);
    await pointer('pointermove', 100, 100); await dom.flushFrames(); assert.equal(queue.scrollTop, 0);
    await pointer('pointermove', 400, 190); await dom.flushFrames(); assert.equal(queue.scrollTop, 0);
    await pointer('pointerup', 400, 190); assert.equal(dom.frames.size, 0);
  });
});

describe('session group synchronization', () => {
  let dom, hooks, calls, response, failure;
  const empty = { groups: [], assignments: {}, removedProjects: [] };
  beforeEach(() => {
    dom = installDom(); hooks = []; calls = []; response = empty; failure = undefined;
    mockIPC(async (command, args) => { calls.push({ command, args }); if (failure) throw failure; return response; }, { shouldMockEvents: true });
  });
  afterEach(async () => { for (const hook of hooks) await hook.unmount(); clearMocks(); dom.restore(); });
  async function mount(sessions = []) { const hook = await renderHook(useSessionGroups, sessions); hooks.push(hook); return hook; }

  test('temporary-directory recognition requires a UUID v4 and an exact path boundary', () => {
    for (const path of ['/home/me/.piop/tmp/12345678-1234-4123-8123-123456789abc', 'C:\\Users\\Me\\.piop\\tmp\\12345678-1234-4123-A123-123456789ABC\\']) assert.equal(isTemporaryChatCwd(path), true);
    for (const path of ['/repo/tmp', '/.piop/tmp/12345678-1234-1123-8123-123456789abc', '/.piop/tmp/12345678-1234-4123-8123-123456789abc/file']) assert.equal(isTemporaryChatCwd(path), false);
  });

  test('session seeds are stable, sorted by host/id and omit temporary chats', async () => {
    const sessions = [{ id: 'b', cwd: '/repo/worktree', projectRoot: '/repo', project: 'fallback', hostId: 'remote', hostName: 'Remote', projectKind: 'worktree' }, { id: 'a', cwd: '/local', project: 'Local' }, { id: 'temp', cwd: '/.piop/tmp/12345678-1234-4123-8123-123456789abc' }];
    const hook = await mount(sessions);
    const seeds = calls[0].args.seeds;
    assert.deepEqual(seeds.map(seed => seed.sessionKey), ['local:a', 'remote:b']);
    assert.equal(seeds[1].project.name, 'repo'); assert.equal(seeds[1].project.cwd, '/repo'); assert.equal(seeds[1].project.hostName, 'Remote');
    assert.equal(seeds[0].project.hostName, 'Local');
    await hook.rerender([...sessions].reverse()); assert.equal(calls.length, 1);
    assert.deepEqual(hook.current.state, empty);
  });

  test('legacy migration validates custom groups and reconstructs project assignments', async () => {
    localStorage.setItem('pi-desktop-removed-project-groups', JSON.stringify(['local:/removed', 42]));
    localStorage.setItem('pi-desktop-custom-session-groups', JSON.stringify([null, {}, { id: 42, name: 'bad' }, { id: 'empty', name: ' ' }, { id: 'custom', name: 'Group' }]));
    localStorage.setItem('pi-desktop-session-locations', JSON.stringify({ custom: '__pi-desktop-custom-group__:custom', project: 'remote:/projects/repo', removed: 'local:/removed', unknown: '__pi-desktop-unknown', invalid: 42, empty: 'local:', unqualified: 'missing' }));
    await mount([{ id: 'removed', cwd: '/removed', project: 'Removed' }]);
    const legacy = calls[0].args.legacy;
    assert.deepEqual(legacy.removedProjects, ['local:/removed']);
    assert.deepEqual(legacy.groups, [{ id: '__pi-desktop-custom-group__:custom', name: 'Group' }, { id: 'remote:/projects/repo', name: 'repo', cwd: '/projects/repo', hostId: 'remote' }]);
    assert.deepEqual(legacy.assignments, { custom: '__pi-desktop-custom-group__:custom', project: 'remote:/projects/repo', removed: null, unknown: null, empty: null, unqualified: null });
  });

  test('corrupt storage is ignored and published changes reach every mounted consumer', async () => {
    localStorage.setItem('pi-desktop-custom-session-groups', '{'); localStorage.setItem('pi-desktop-session-locations', '[]');
    const first = await mount(); const second = await mount();
    assert.deepEqual(calls[0].args.legacy, empty);
    response = { ...empty, groups: [{ id: 'group', name: 'New' }] };
    await act(async () => first.current.change({ type: 'create', name: 'New' }));
    assert.deepEqual(first.current.state, response); assert.deepEqual(second.current.state, response);
    assert.deepEqual(calls.at(-1), { command: 'change_session_groups', args: { change: { type: 'create', name: 'New' } } });
    await act(async () => emit('pi://groups-changed', empty));
    assert.deepEqual(first.current.state, empty); assert.deepEqual(second.current.state, empty);
  });

  test('load and mutation errors surface to consumers and do not poison subsequent queued work', async () => {
    failure = new Error('offline'); const hook = await mount(); assert.match(hook.current.error, /offline/);
    await act(async () => assert.rejects(hook.current.change({ type: 'remove', id: 'group' }), /offline/));
    failure = undefined; await act(async () => hook.current.change({ type: 'assign', key: 'session', group: null }));
    assert.equal(hook.current.error, undefined); assert.deepEqual(hook.current.state, empty);
  });
});
