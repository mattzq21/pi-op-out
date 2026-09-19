import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { SessionPanel } from '../../src/components/SessionPanel.tsx';

describe('conversation sidebar', () => {
  let dom, view, props, groups, changes, nativeCalls, responses;
  function responseFor(command) { const result = responses.get(command); if (result instanceof Error) throw result; return result; }
  const session = (id, name, extra = {}) => ({ id, name, cwd: '/repo', project: 'repo', projectRoot: '/repo', projectKind: 'main', ...extra });
  beforeEach(() => {
    dom = installDom(); HTMLElement.prototype.scrollTo = () => {};
    nativeCalls = []; responses = new Map();
    groups = { groups: [{ id: 'local:/repo', name: 'repo', cwd: '/repo', projectKind: 'main' }], assignments: { 'local:a': 'local:/repo', 'local:b': 'local:/repo' }, removedProjects: [] }; changes = [];
    mockIPC(async (command, args) => {
      nativeCalls.push({ command, args });
      if (responses.has(command)) return responseFor(command);
      if (command === 'load_session_groups') return structuredClone(groups);
      if (command === 'change_session_groups') {
        const change = args.change; changes.push(change);
        if (change.type === 'assign') groups.assignments[change.key] = change.group;
        if (change.type === 'create') groups.groups.push({ id: 'custom', name: change.name });
        if (change.type === 'rename') groups.groups = groups.groups.map(group => group.id === change.id ? { ...group, name: change.name } : group);
        if (change.type === 'remove') { groups.groups = groups.groups.filter(group => group.id !== change.id); for (const key of Object.keys(groups.assignments)) if (groups.assignments[key] === change.id) groups.assignments[key] = null; }
        return structuredClone(groups);
      }
      throw new Error(`Unexpected command: ${command}`);
    }, { shouldMockEvents: true });
    props = { sessions: [session('b', 'Chat 10'), session('a', 'Chat 2')], query: '', onQuery: () => {}, onSelect: () => {}, onAction: () => {}, onNewChat: () => {}, onCreateWorktree: () => {}, onDeleteWorktree: async () => {} };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; clearMocks(); dom.restore(); });
  async function render(extra = {}) { props = { ...props, ...extra }; if (view) await view.rerender(props); else view = await renderComponent(SessionPanel, props); }
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const row = id => document.querySelector(`[data-session-key="local:${id}"] .session-main`);
  const click = async element => act(async () => element.click());
  const key = async (element, key, extra = {}) => act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })));
  const menu = async id => act(async () => row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
  const mouse = async (target, type, x = 20, y = 20, extra = {}) => act(async () => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra })));
  function hit(element, top = 40) { document.elementFromPoint = () => element; if (element) element.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40, left: 0, right: 200, width: 200 }); }
  const menuAction = text => [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === text);

  test('sorts conversations naturally and selects or archives the exact session', async () => {
    const selected = [], actions = [];
    await render({ activeId: 'a', runningSessions: new Set(['local:b']), onSelect: value => selected.push(value), onAction: (...args) => actions.push(args) });
    assert.deepEqual([...document.querySelectorAll('.session-main strong')].map(item => item.textContent), ['Chat 2', 'Chat 10']);
    assert.equal(row('a').getAttribute('aria-current'), 'page'); assert.match(row('b').getAttribute('aria-label'), /Running/);
    await click(row('a')); assert.equal(selected[0], props.sessions[1]);
    await click(control('Archive Chat 10')); assert.deepEqual(actions, [[props.sessions[0], 'archive']]);
    await render({ runningSessions: new Set(), unseenSessions: new Set(['local:b']) }); assert.match(row('b').getAttribute('aria-label'), /New activity/);
  });

  test('context actions omit splitting the active session and support keyboard focus navigation', async () => {
    const actions = []; await render({ activeId: 'a', onAction: (...args) => actions.push(args) });
    row('a').focus(); await menu('a'); await dom.flushFrames();
    assert.equal([...document.querySelectorAll('[role=menuitem]')].some(item => item.textContent === 'Split pane'), false);
    await key(document.activeElement, 'End'); assert.equal(document.activeElement.textContent, 'Open project directory');
    await key(document.activeElement, 'Home'); assert.equal(document.activeElement.textContent, 'Open in new window');
    await key(document.activeElement, 'ArrowDown'); assert.equal(document.activeElement.textContent, 'Rename conversation'); await click(document.activeElement);
    assert.deepEqual(actions, [[props.sessions[1], 'rename']]); await dom.flushFrames(); assert.equal(document.activeElement, row('a'));
    await menu('b'); await dom.flushFrames(); assert.equal(document.activeElement.textContent, 'Split pane'); await key(document.activeElement, 'Escape'); assert.equal(document.querySelector('[role=menu]'), null);
  });

  test('collapsed groups persist and search temporarily reveals matching conversations', async () => {
    const queries = []; await render({ onQuery: value => queries.push(value) });
    await click(document.querySelector('.project-label')); assert.equal(document.querySelector('.project-label').getAttribute('aria-expanded'), 'false'); assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-collapsed-projects')), ['local:/repo']);
    await enterText(control('Search conversations'), 'Chat 2'); assert.deepEqual(queries, ['Chat 2']);
    await render({ query: 'Chat 2' }); assert.equal(document.querySelector('.project-label').disabled, true); assert.ok(row('a')); assert.equal(row('b'), null);
    await render({ query: 'missing' }); assert.match(document.querySelector('.empty-small').textContent, /No conversations match/);
    await key(window, 'g', { ctrlKey: true }); assert.equal(document.activeElement, control('Search conversations'));
  });

  test('keyboard reordering persists the order and new-chat actions select the group', async () => {
    const chats = []; await render({ onNewChat: group => chats.push(group) });
    await key(row('a'), 'ArrowDown', { altKey: true });
    assert.deepEqual([...document.querySelectorAll('.session-main strong')].map(item => item.textContent), ['Chat 10', 'Chat 2']);
    assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-session-orders'))['local:/repo'], ['local:b', 'local:a']); assert.deepEqual(changes.at(-1), { type: 'assign', key: 'local:a', group: 'local:/repo' });
    await click(control('New chat in repo')); assert.deepEqual(chats, [groups.groups[0]]);
  });

  test('new groups reject reserved names, save trimmed names and allow renaming', async () => {
    let handled = 0; await render({ createGroupRequest: 1, onCreateGroupHandled: () => handled++ }); await dom.flushFrames(); assert.equal(handled, 1);
    await key(control('New session group name'), 'Enter'); assert.match(document.querySelector('#new-group-error').textContent, /Enter a group name/);
    await enterText(control('New session group name'), 'Recent'); await key(control('New session group name'), 'Enter'); assert.match(document.querySelector('#new-group-error').textContent, /already uses/);
    await enterText(control('New session group name'), '  Research  '); await key(control('New session group name'), 'Enter'); assert.deepEqual(changes.at(-1), { type: 'create', name: 'Research' });
    await click(control('Rename group Research')); await enterText(control('Rename session group'), 'Notes'); await key(control('Rename session group'), 'Enter'); assert.deepEqual(changes.at(-1), { type: 'rename', id: 'custom', name: 'Notes' });
  });

  test('mouse drag reorders sessions after the movement threshold and suppresses the release click', async () => {
    const selected = []; await render({ onSelect: value => selected.push(value) });
    hit(row('b').parentElement); await mouse(row('a'), 'mousedown'); await mouse(window, 'mousemove', 22, 22); assert.equal(document.querySelector('.dragging'), null);
    await mouse(window, 'mousemove', 20, 75); assert.ok(row('a').parentElement.classList.contains('dragging')); assert.ok(row('b').parentElement.classList.contains('drop-after'));
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); row('a').click(); });
    assert.deepEqual(selected, []); assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-session-orders'))['local:/repo'], ['local:b', 'local:a']); assert.equal(document.querySelector('.dragging'), null);
    await click(row('a')); assert.equal(selected.length, 1);
  });

  test('dragging to a collapsed group moves the conversation and expands its destination', async () => {
    groups.groups.push({ id: 'custom', name: 'Research' }); localStorage.setItem('pi-desktop-collapsed-projects', JSON.stringify(['custom']));
    await render(); const heading = document.querySelector('[data-drop-project-key=custom]'); hit(heading);
    await mouse(row('a'), 'mousedown'); await mouse(window, 'mousemove', 50, 60); await mouse(window, 'mouseup');
    assert.deepEqual(changes.at(-1), { type: 'assign', key: 'local:a', group: 'custom' }); assert.equal(row('a').parentElement.dataset.projectKey, 'custom'); assert.equal(heading.querySelector('.project-label').getAttribute('aria-expanded'), 'true');
  });

  test('drag cancellation and invalid targets preserve assignments and stop auto scrolling', async () => {
    await render(); const scroll = document.querySelector('.session-scroll'); scroll.getBoundingClientRect = () => ({ top: 0, bottom: 200 });
    hit(null); await mouse(row('a'), 'mousedown'); await mouse(window, 'mousemove', 20, 195); await dom.flushFrames(); assert.ok(scroll.scrollTop > 0);
    await act(async () => window.dispatchEvent(new Event('blur'))); assert.equal(document.querySelector('.dragging'), null); assert.equal(dom.frames.size, 0); assert.deepEqual(changes, []);
    await mouse(row('a'), 'mousedown'); await mouse(window, 'mousemove', 30, 60); await mouse(window, 'mouseup'); assert.deepEqual(changes, []);
    await mouse(row('a'), 'mousedown', 20, 20, { button: 2 }); await mouse(window, 'mousemove', 30, 60); assert.equal(document.querySelector('.dragging'), null);
    await render({ query: 'Chat' }); await mouse(row('a'), 'mousedown'); await mouse(window, 'mousemove', 30, 60); assert.equal(document.querySelector('.dragging'), null);
  });

  test('project dragging persists sidebar order and keyboard shortcuts can move sessions between groups', async () => {
    groups.groups.push({ id: 'custom', name: 'Research' }); await render();
    const source = document.querySelector('[data-drop-project-key="local:/repo"] .project-label');
    const target = document.querySelector('[data-sidebar-token="group:custom"]'); hit(target);
    await mouse(source, 'mousedown'); await mouse(window, 'mousemove', 20, 75); await mouse(window, 'mouseup');
    assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-sidebar-order')), ['group:custom', 'group:local:/repo']);
    await key(row('a'), 'ArrowUp', { altKey: true, shiftKey: true }); assert.equal(row('a').parentElement.dataset.projectKey, 'custom');
    await key(document.querySelector('[data-drop-project-key=custom] .project-label'), 'ArrowDown', { altKey: true });
    assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-sidebar-order')), ['group:local:/repo', 'group:custom']);
  });

  test('forgetting a group releases chats and removes persisted grouping preferences', async () => {
    localStorage.setItem('pi-desktop-session-orders', JSON.stringify({ 'local:/repo': ['local:b', 'local:a'] }));
    localStorage.setItem('pi-desktop-collapsed-projects', JSON.stringify(['local:/repo']));
    await render(); await click(control('Group actions for repo')); await click(menuAction('Forget group'));
    assert.match(document.querySelector('dialog').textContent, /No chats or directories will be deleted/);
    await click(document.querySelector('dialog .primary-button'));
    assert.equal(document.querySelector('dialog'), null); assert.equal(control('Group actions for repo'), null); assert.ok(row('a')); assert.ok(row('b'));
    assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-session-orders')), {}); assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-collapsed-projects')), []);
    assert.deepEqual(JSON.parse(localStorage.getItem('pi-desktop-sidebar-order')), ['session:local:b', 'session:local:a']);
  });

  test('group actions route directory and worktree requests and surface native errors', async () => {
    const created = []; responses.set('open_project_directory', new Error('directory missing'));
    await render({ onCreateWorktree: (...args) => created.push(args) });
    await click(control('Group actions for repo')); await click(menuAction('Open directory')); assert.match(document.querySelector('[role=alert]').textContent, /directory missing/);
    assert.deepEqual(nativeCalls.find(call => call.command === 'open_project_directory').args, { cwd: '/repo', hostId: 'local' });
    await click(control('Group actions for repo')); await click(menuAction('Create worktree')); assert.deepEqual(created, [['/repo', 'local']]);
  });

  test('worktree deletion checks conversation roots and blocks deletion while chats depend on it', async () => {
    groups.groups[0].projectKind = 'worktree'; responses.set('git_worktree_roots', ['/repo', '/repo', '/elsewhere']);
    await render({ sessions: props.sessions.map(item => ({ ...item, projectKind: 'worktree' })) });
    await click(control('Group actions for repo')); await click(menuAction('Delete worktree…'));
    assert.match(document.querySelector('dialog [role=alert]').textContent, /1 conversation/); assert.equal(document.querySelector('dialog .primary-button').disabled, true);
    await click(document.querySelector('dialog button')); assert.equal(document.querySelector('dialog'), null);
    responses.set('git_worktree_roots', [null]); await click(control('Group actions for repo')); await click(menuAction('Delete worktree…')); assert.match(document.querySelector('[role=alert]').textContent, /Could not resolve/); assert.equal(document.querySelector('dialog'), null);
  });

  test('worktree deletion passes branch preference and reports a subsequent group cleanup failure', async () => {
    groups.groups[0].projectKind = 'worktree'; responses.set('git_worktree_roots', ['/repo']); const deleted = [];
    await render({ sessions: [], onDeleteWorktree: async (...args) => deleted.push(args) });
    await click(control('Group actions for repo')); await click(menuAction('Delete worktree…')); await click(document.querySelector('dialog input[type=checkbox]'));
    responses.set('change_session_groups', new Error('storage unavailable'));
    await click(document.querySelector('dialog .primary-button'));
    assert.deepEqual(deleted, [['/repo', 'local', true]]); assert.equal(document.querySelector('dialog'), null); assert.match(document.querySelector('[role=alert]').textContent, /storage unavailable/);
  });
});
