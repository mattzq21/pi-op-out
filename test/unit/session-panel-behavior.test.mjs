import { installDom, renderComponent, act, untilDom, enterText, attributeBecomes } from '../dom.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent, mergeProps } from 'solid-js';
import { SessionPanel } from '../../clients/ui/components/SessionPanel.tsx';
import { createSidebarState } from '../../clients/ui/lib/sidebarState.ts';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { emit } from '@tauri-apps/api/event';
import { trackStorage } from '../storage-idle.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function Panel(props) {
  const sidebar = createSidebarState(() => props.sessions, () => props.query);
  return createComponent(SessionPanel, mergeProps(props, { sidebar }));
}
const session = (id, name, extra = {}) => ({ id, name, path: `/sessions/${id}.jsonl`, cwd: process.cwd(), project: 'repo', messageCount: 1, ...extra });
let sessionIds = new Map();
const row = (id, host = 'local') => document.querySelector(`[data-session-key="${host}:${sessionIds.get(id) ?? id}"] .session-main`);
const control = label => document.querySelector(`[aria-label="${label}"]`);
const click = element => act(() => element.click());

async function fixture(t, props, group = 'repo', native, beforeMount, options = {}) {
  let view, dom, storage;
  let eventsReady = false;
  const otherViews = [], eventErrors = [];
  const requests = new Set();
  const settled = async () => { do { await act(async () => { while (requests.size) await Promise.allSettled([...requests]); }); } while (requests.size); };
  t.after(async () => {
    await settled();
    for (const other of otherViews) await other.unmount();
    await view?.unmount(); await settled();
    eventsReady = false;
    await storage?.settled(); storage?.restore(); clearMocks(); dom?.restore();
    assert.deepEqual(eventErrors, []);
  });
  const daemon = await daemonClient(t, (event, payload) => {
    if (!eventsReady || event !== 'pi://groups-changed') return;
    const forwarded = emit(event, payload);
    requests.add(forwarded);
    forwarded.then(() => requests.delete(forwarded), error => { requests.delete(forwarded); eventErrors.push(error); });
  }, options);
  sessionIds = new Map();
  const temporaryDirectories = new Map();
  async function registerProps(input) {
    for (const item of input.sessions ?? []) {
      if (![...sessionIds.values()].includes(item.id)) {
        if (!sessionIds.has(item.id)) {
          const chat = await daemon.invoke('create_temporary_chat', { hostId: item.hostId ?? 'local' });
          sessionIds.set(item.id, chat.sessionId);
          temporaryDirectories.set(chat.sessionId, chat.cwd);
        }
        item.id = sessionIds.get(item.id);
      }
      if (item.cwd === undefined) item.cwd = temporaryDirectories.get(item.id);
    }
    for (const item of input.sessions ?? []) if (item.subagentParentId) item.subagentParentId = sessionIds.get(item.subagentParentId) ?? item.subagentParentId;
    for (const item of input.sessions ?? []) if (item.forkSourceId) item.forkSourceId = sessionIds.get(item.forkSourceId) ?? item.forkSourceId;
    await daemon.listChats(input.sessions ?? []);
    const mapped = { ...input };
    if (mapped.activeId) mapped.activeId = sessionIds.get(mapped.activeId) ?? mapped.activeId;
    for (const field of ['runningSessions', 'unseenSessions']) if (mapped[field]) mapped[field] = new Set([...mapped[field]].map(key => key.startsWith('local:') ? 'local:' + (sessionIds.get(key.slice(6)) ?? key.slice(6)) : key));
    return mapped;
  }
  props = await registerProps(props);
  dom = installDom();
  storage = trackStorage(indexedDB);
  HTMLElement.prototype.scrollTo = () => {};
  let loaded = Promise.withResolvers();
  mockIPC(async (command, args) => {
    const request = command === 'open_project_directory' && native ? native.invoke(command, args) : daemon.invoke(command, args);
    requests.add(request);
    try {
      const result = await request;
      return result;
    } finally {
      if (command === 'load_session_groups') loaded.resolve();
      requests.delete(request);
    }
  }, { shouldMockEvents: true });
  const sdkInvoke = window.__TAURI_INTERNALS__.invoke;
  // The installed Tauri mock expects id, but its event API passes eventId.
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => sdkInvoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  eventsReady = true;
  await beforeMount?.(daemon);
  props = { query: '', isArchiving: () => false, onQuery: () => {}, onSelect: () => {}, onAction: () => {}, onNewChat: () => {}, ...props };
  async function mount(readyGroup = group) {
    loaded = Promise.withResolvers();
    view = await renderComponent(Panel, props);
    await act(() => loaded.promise);
    await storage.settled();
    if (readyGroup !== null) await untilDom(() => control(`Collapse ${readyGroup}`) || control(`Expand ${readyGroup}`));
  }
  await mount();
  return {
    service: daemon,
    get container() { return view.container; },
    async openAnother() {
      loaded = Promise.withResolvers();
      const another = await renderComponent(Panel, props);
      otherViews.push(another);
      await act(() => loaded.promise); await settled(); await storage.settled();
      return another.container;
    },
    async render(changes) { props = { ...props, ...await registerProps(changes) }; await view.rerender(props); },
    async reopen(changes = {}, readyGroup = group) {
      await settled(); await view.unmount(); await storage.settled();
      props = { ...props, ...await registerProps(changes) }; await mount(readyGroup);
    },
  };
}
const key = (element, key, extra = {}) => act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })));
const names = () => [...document.querySelectorAll('.session-main strong')].map(element => element.textContent);

test('child conversations remain manageable after their parent is archived', async t => {
  const child = session('child', 'Delegated task', { subagentParentId: 'parent' });
  const actions = [];
  const panel = await fixture(t, { sessions: [session('parent', 'Parent'), child], onAction: (...args) => actions.push(args) });
  assert.equal(row('child'), null);
  await panel.render({ sessions: [child] });
  assert.ok(row('child'));
  await click(control('Archive Delegated task'));
  assert.deepEqual(actions, [[child, 'archive']]);
});

test('a remote child is hidden only by its parent on the same machine', { timeout: 30_000 }, async t => {
  const remoteHost = { hostId: 'remote', hostName: 'Remote', project: 'folder', cwd: process.cwd() + '/test' };
  const localParent = session('parent', 'Local parent', { project: 'Local' });
  const remoteParent = session('parent', 'Remote parent', remoteHost);
  const child = session('child', 'Delegated task', { ...remoteHost, subagentParentId: 'parent' });
  const selected = [], actions = [];
  const panel = await fixture(t, { sessions: [localParent, child], onSelect: value => selected.push(value), onAction: (...args) => actions.push(args) }, 'Local', undefined, undefined, { remotes: [{ id: 'remote', name: 'Remote', target: 'remote' }] });
  assert.equal(child.subagentParentId, localParent.id);
  await click(row('child', 'remote'));
  assert.deepEqual(selected, [child]);
  await panel.render({ sessions: [localParent, remoteParent, child] });
  assert.equal(remoteParent.id, localParent.id);
  assert.ok(row('parent', 'remote'));
  assert.equal(row('child', 'remote'), null);
  await panel.render({ sessions: [localParent, child] });
  assert.ok(row('parent'));
  await click(control('Archive Delegated task'));
  assert.deepEqual(actions, [[child, 'archive']]);
});

test('conversation list interactions', async t => {
  const selected = [], actions = [], queries = [];
  const first = session('a', 'Chat 2'), target = session('b', 'Chat 10');
  const panel = await fixture(t, { sessions: [target, first], onSelect: value => selected.push(value), onAction: (...args) => actions.push(args), onQuery: query => queries.push(query) });
  await t.test('conversation names sort naturally', async () => {
    assert.deepEqual([...document.querySelectorAll('.session-main strong')].map(element => element.textContent), ['Chat 2', 'Chat 10']);
  });

  await t.test('selecting a conversation returns that conversation to the caller', async () => {
    await click(row('a'));
    assert.deepEqual(selected, [first]);
  });

  await t.test('archiving a conversation returns the selected conversation and action', async () => {
    await click(control('Archive Chat 10'));
    assert.deepEqual(actions, [[target, 'archive']]);
  });

  await t.test('typing a conversation search returns the query to the caller', async () => {
    await enterText(control('Search conversations'), 'Chat 2');
    assert.deepEqual(queries, ['Chat 2']);
  });

  await t.test('a search without matching conversations shows an empty result message', async () => {
    await panel.render({ query: 'missing' });
    assert.deepEqual(names(), []);
    assert.match(document.body.textContent, /No conversations match/);
  });
});

test('the selected conversation is marked as the current page', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2'), session('b', 'Chat 10')], activeId: 'a' });
  assert.equal(row('a').getAttribute('aria-current'), 'page');
  assert.equal(row('b').hasAttribute('aria-current'), false);
  await panel.render({ activeId: 'b' });
  assert.equal(row('b').getAttribute('aria-current'), 'page');
  assert.equal(row('a').hasAttribute('aria-current'), false);
});

test('conversation activity labels follow running and unseen activity', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2'), session('b', 'Chat 10')], runningSessions: new Set(['local:b']) });
  assert.match(row('b').getAttribute('aria-label'), /Running/);
  assert.doesNotMatch(row('a').getAttribute('aria-label'), /Running|New activity/);
  await panel.render({ runningSessions: new Set(), unseenSessions: new Set(['local:b']) });
  assert.match(row('b').getAttribute('aria-label'), /New activity/);
  assert.doesNotMatch(row('b').getAttribute('aria-label'), /Running/);
});

const menuAction = text => [...document.querySelectorAll('[role=menuitem]')].find(element => element.textContent === text);

test('new chat uses the selected project group', async t => {
  const chats = [];
  await fixture(t, { sessions: [session('a', 'Chat 2'), session('b', 'Chat 10', { cwd: process.cwd() + '/test', project: 'tests' })], onNewChat: group => chats.push(group) });
  await click(control('New chat in repo'));
  assert.deepEqual(chats.map(({ name, cwd }) => ({ name, cwd })), [{ name: 'repo', cwd: process.cwd() }]);
});

async function createGroup(panel, name) {
  await panel.render({ createGroupRequest: 1 });
  await enterText(control('Group name'), name);
  await key(control('Group name'), 'Enter');
  await untilDom(() => control(`Group actions for ${name.trim()}`) && !control('Group name'));
}

const groupContents = name => {
  const disclosure = control(`Collapse ${name}`) ?? control(`Expand ${name}`);
  return document.getElementById(disclosure.getAttribute('aria-controls'));
};

const dialogButton = text => [...document.querySelectorAll('dialog button')].find(button => button.textContent === text);
async function forgetGroup(name) {
  await click(control(`Group actions for ${name}`));
  await click(menuAction('Forget group'));
  await click(dialogButton('Forget group'));
  await untilDom(() => !document.querySelector('dialog') && !control(`Group actions for ${name}`));
}

test('forgetting a group moves its conversations to Recents after reopening', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2'), session('b', 'Chat 10')] });
  await forgetGroup('repo');
  await panel.reopen({}, 'Recents');
  assert.equal(control('Group actions for repo'), null);
  assert.ok(groupContents('Recents').contains(row('a')));
  assert.ok(groupContents('Recents').contains(row('b')));
  assert.deepEqual(names(), ['Chat 2', 'Chat 10']);
});

test("temporary chat directories stay out of project groups", async t => {
  const root = await mkdtemp(join(tmpdir(), 'piop-panel-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = root + '/' + ".piop/tmp/12345678-1234-4123-8123-123456789abc";
  await mkdir(directory, { recursive: true });
  await fixture(t, { sessions: [session('a', 'Chat 2', { cwd: directory })] }, "Recents");
  assert.equal(control('Group actions for repo'), null);
  assert.ok(groupContents('Recents').contains(row('a')));
});

test("temporary chat paths accept uppercase UUIDs and a trailing slash", async t => {
  const root = await mkdtemp(join(tmpdir(), 'piop-panel-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = root + '/' + ".piop/tmp/12345678-1234-4123-A123-123456789ABC/";
  await mkdir(directory, { recursive: true });
  await fixture(t, { sessions: [session('a', 'Chat 2', { cwd: directory })] }, "Recents");
  assert.equal(control('Group actions for repo'), null);
  assert.ok(groupContents('Recents').contains(row('a')));
});

test("ordinary tmp directories remain project groups", async t => {
  const root = await mkdtemp(join(tmpdir(), 'piop-panel-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = root + '/' + "repo/tmp";
  await mkdir(directory, { recursive: true });
  await fixture(t, { sessions: [session('a', 'Chat 2', { cwd: directory })] }, "repo");
  assert.ok(control('Group actions for repo'));
  assert.ok(groupContents('repo').contains(row('a')));
});

test("non-v4 UUID directories remain project groups", async t => {
  const root = await mkdtemp(join(tmpdir(), 'piop-panel-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = root + '/' + ".piop/tmp/12345678-1234-1123-8123-123456789abc";
  await mkdir(directory, { recursive: true });
  await fixture(t, { sessions: [session('a', 'Chat 2', { cwd: directory })] }, "repo");
  assert.ok(control('Group actions for repo'));
  assert.ok(groupContents('repo').contains(row('a')));
});

test("directories below a temporary chat remain project groups", async t => {
  const root = await mkdtemp(join(tmpdir(), 'piop-panel-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = root + '/' + ".piop/tmp/12345678-1234-4123-8123-123456789abc/file";
  await mkdir(directory, { recursive: true });
  await fixture(t, { sessions: [session('a', 'Chat 2', { cwd: directory })] }, "repo");
  assert.ok(control('Group actions for repo'));
  assert.ok(groupContents('repo').contains(row('a')));
});

test('old browser group records do not replace the current project groups', async t => {
  await fixture(t, { sessions: [session('a', 'Chat 2')] }, 'repo', undefined, () => {
    localStorage.setItem('pi-desktop-removed-project-groups', JSON.stringify(['local:' + process.cwd()]));
    localStorage.setItem('pi-desktop-custom-session-groups', JSON.stringify([{ id: 'custom', name: 'Old group' }]));
    localStorage.setItem('pi-desktop-session-locations', JSON.stringify({ custom: '__pi-desktop-custom-group__:custom' }));
  });
  assert.ok(control('Group actions for repo'));
  assert.ok(groupContents('repo').contains(row('a')));
  assert.equal(control('Group actions for Old group'), null);
});

test('a reopened panel retains loaded groups offline and refreshes them on its next load', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2')] });
  await createGroup(panel, 'Research');
  await panel.service.disconnect();
  await panel.reopen({ createGroupRequest: 0 }, 'Research');
  assert.ok(control('Group actions for Research'));
  assert.match(document.body.textContent, /connection is not open/i);
  await panel.service.reconnect();
  const state = await panel.service.invoke('load_session_groups', { seeds: [] });
  const research = state.groups.find(group => group.name === 'Research');
  await panel.service.invoke('change_session_groups', { change: { type: 'rename', id: research.id, name: 'Updated research' } });
  await panel.reopen({}, 'Updated research');
  assert.ok(control('Group actions for Updated research'));
  assert.equal(control('Group actions for Research'), null);
  assert.doesNotMatch(document.body.textContent, /connection is not open/i);
});

test('group loading recovers when the panel reopens after reconnection', async t => {
  const panel = await fixture(t, { sessions: [] }, null, undefined, service => service.disconnect());
  assert.match(document.body.textContent, /connection is not open/i);
  await panel.service.reconnect();
  await panel.reopen({}, 'Recents');
  assert.doesNotMatch(document.body.textContent, /connection is not open/i);
  await createGroup(panel, 'Recovered group');
  assert.ok(control('Group actions for Recovered group'));
});

test('corrupt browser group records do not prevent current groups from loading', async t => {
  await fixture(t, { sessions: [session('a', 'Chat 2')] }, 'repo', undefined, () => {
    localStorage.setItem('pi-desktop-custom-session-groups', '{');
    localStorage.setItem('pi-desktop-session-locations', '[]');
  });
  assert.ok(groupContents('repo').contains(row('a')));
  assert.equal(document.querySelector('[role=alert]'), null);
});

test('creating a group updates every mounted sidebar panel', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2')] });
  const second = await panel.openAnother();
  await createGroup(panel, 'Shared group');
  assert.ok(panel.container.querySelector('[aria-label="Group actions for Shared group"]'));
  assert.ok(second.querySelector('[aria-label="Group actions for Shared group"]'));
});

test('server group removal reaches every mounted sidebar panel', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2')] });
  const second = await panel.openAnother();
  await createGroup(panel, 'Shared group');
  const groups = await panel.service.invoke('load_session_groups', { seeds: [] });
  const shared = groups.groups.find(group => group.name === 'Shared group');
  await panel.service.invoke('change_session_groups', { change: { type: 'remove', id: shared.id } });
  await untilDom(() => !panel.container.querySelector('[aria-label="Group actions for Shared group"]') && !second.querySelector('[aria-label="Group actions for Shared group"]'));
  assert.ok(panel.container.querySelector('[aria-label="Group actions for repo"]'));
  assert.ok(second.querySelector('[aria-label="Group actions for repo"]'));
});

test('local and remote conversations display their project and machine names', async t => {
  await fixture(t, { sessions: [session('b', 'Remote conversation', { hostId: 'remote', hostName: 'Remote', project: 'folder', cwd: process.cwd() + '/test' }), session('a', 'Local conversation', { project: 'Local' })] }, 'Local', undefined, undefined, { remotes: [{ id: 'remote', name: 'Remote', target: 'remote' }] });
  assert.ok(control('Group actions for Local'));
  assert.ok(control('Group actions for Remote / folder'));
  assert.ok(groupContents('Local').contains(row('a')));
  assert.ok(groupContents('Remote / folder').contains(row('b', 'remote')));
});

test('local and remote conversations with the same id stay separate', { timeout: 30_000 }, async t => {
  const local = session('shared', 'Local conversation', { project: 'Local' });
  const remote = session('shared', 'Remote conversation', { hostId: 'remote', hostName: 'Remote', project: 'folder', cwd: process.cwd() + '/test' });
  const selected = [], actions = [];
  const panel = await fixture(t, { sessions: [local, remote], activeId: 'shared', activeHostId: 'local', onSelect: value => selected.push(value), onAction: (...args) => actions.push(args) }, 'Local', undefined, undefined, { remotes: [{ id: 'remote', name: 'Remote', target: 'remote' }] });
  const sharedId = sessionIds.get('shared');
  assert.equal(remote.id, sharedId);
  assert.equal(local.id, sharedId);
  assert.equal(row('shared').getAttribute('aria-current'), 'page');
  assert.equal(row('shared', 'remote').hasAttribute('aria-current'), false);
  await click(row('shared', 'remote'));
  await click(control('Archive Local conversation'));
  await click(control('Archive Remote conversation'));
  assert.deepEqual(selected, [remote]);
  assert.deepEqual(actions, [[local, 'archive'], [remote, 'archive']]);
  await panel.render({ activeHostId: 'remote' });
  assert.equal(row('shared', 'remote').getAttribute('aria-current'), 'page');
  assert.equal(row('shared').hasAttribute('aria-current'), false);
});

test('a failed group rename keeps the typed name and saves it when retried after reconnection', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2')] });
  await createGroup(panel, 'Research');
  await click(control('Group actions for Research'));
  await click(menuAction('Rename group'));
  const input = await untilDom(() => control('Rename session group'));
  await enterText(input, 'Notes');
  await panel.service.disconnect();
  await key(input, 'Enter');
  await attributeBecomes(input, 'aria-invalid', 'true');
  assert.equal(control('Rename session group'), input);
  assert.equal(input.value, 'Notes');
  assert.match(document.getElementById(input.getAttribute('aria-describedby')).textContent, /connection is not open/i);
  await panel.service.reconnect();
  await key(input, 'Enter');
  await untilDom(() => control('Group actions for Notes') && !control('Rename session group'));
  await panel.reopen({}, 'Notes');
  assert.ok(control('Group actions for Notes'));
  assert.equal(control('Group actions for Research'), null);
  assert.doesNotMatch(document.body.textContent, /connection is not open/i);
});

test('a branch in its own worktree folder joins its source chat\'s group, and the worktree folder gets no group', async t => {
  const root = await mkdtemp(join(tmpdir(), 'piop-panel-branch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = '0190a6e3-8c42-7b05-a281-3d96e04fc812';
  const worktree = join(root, '.local/share/piop/worktrees', folder);
  await mkdir(worktree, { recursive: true });
  const source = session('source', 'Source chat');
  const panel = await fixture(t, { sessions: [source] });
  await panel.render({ sessions: [source, session('branch', 'Branch chat', { cwd: worktree, project: folder, forkSourceId: 'source' })] });
  await untilDom(() => row('branch') && groupContents('repo').contains(row('branch')));
  assert.equal(control('Group actions for ' + folder), null);
  await panel.reopen();
  assert.ok(groupContents('repo').contains(row('branch')));
  assert.equal(control('Group actions for ' + folder), null);
});

test('starting a new chat closes the new-group form that the Group button opened', async t => {
  const panel = await fixture(t, { sessions: [session('a', 'Chat 2')] });
  await panel.render({ createGroupRequest: 1 });
  await untilDom(() => control('Group name'));
  await panel.render({ newChatRequest: 1 });
  await untilDom(() => !control('Group name'));
  await panel.render({ createGroupRequest: 2 });
  await enterText(control('Group name'), 'Kept');
  await key(control('Group name'), 'Enter');
  await untilDom(() => control('Group actions for Kept') && !control('Group name'));
  await panel.render({ newChatRequest: 2 });
  assert.ok(control('Group actions for Kept'), 'existing groups stay');
});
