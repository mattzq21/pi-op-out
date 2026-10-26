import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { createSidepaneTabs } from '../../clients/ui/lib/sidepaneTabs.ts';

const session = (id, extra = {}) => ({ id, hostId: 'local', name: id, path: `/sessions/${extra.created ?? '2026-01-01T00-00-00-000Z'}_${id}.jsonl`, project: 'p', cwd: '/p', preview: '', messageCount: 0, lastMessageAt: 0, apiCost: 0, ...extra });

/** Saved subagent tabs that outlive one tab state, as local storage does across app restarts. */
const memoryStore = () => { let saved = []; return { load: () => saved, save: keys => { saved = keys; } }; };

function tabs(initial, mainId = 'main', store = memoryStore()) {
  return createRoot(dispose => {
    const [sessions, setSessions] = createSignal(initial);
    const [main, setMain] = createSignal(mainId);
    const tabs = createSidepaneTabs({ sessions, main: () => ({ hostId: 'local', sessionId: main() }), running: item => Boolean(item.isRunning), subagentTabs: store, onError: message => { throw new Error(message); } });
    return { tabs, setSessions, setMain, dispose, keys: () => tabs.tabs().map(tab => tab.key.slice('local:'.length)) };
  });
}

test('the tabs are the main chat\'s btw and review chats, also those of its auxiliary chats, oldest first', t => {
  const view = tabs([
    session('main'), session('other'),
    session('review', { auxiliaryParentId: 'main', auxiliaryKind: 'review', created: '2026-01-02' }),
    session('btw', { auxiliaryParentId: 'main', auxiliaryKind: 'btw', created: '2026-01-01' }),
    session('nested', { auxiliaryParentId: 'btw', auxiliaryKind: 'review', created: '2026-01-03' }),
    session('foreign', { auxiliaryParentId: 'other', auxiliaryKind: 'btw' }),
  ]);
  t.after(view.dispose);
  assert.deepEqual(view.keys(), ['btw', 'review', 'nested']);
  view.setMain('other');
  assert.deepEqual(view.keys(), ['foreign']);
});

test('a subagent gets a tab while it works and keeps it until closed; a new run brings it back', t => {
  const idle = session('helper', { auxiliaryParentId: 'main', auxiliaryKind: 'subagent', name: 'Subagent: Helper' });
  const view = tabs([session('main'), idle]);
  t.after(view.dispose);
  assert.deepEqual(view.keys(), []);
  view.setSessions([session('main'), { ...idle, isRunning: true }]);
  assert.deepEqual(view.tabs.tabs().map(tab => [tab.label, tab.running]), [['Helper', true]]);
  assert.equal(view.tabs.working(), true);
  view.setSessions([session('main'), idle]);
  assert.deepEqual(view.keys(), ['helper']);
  view.tabs.forget('local:helper');
  assert.deepEqual(view.keys(), []);
  view.setSessions([session('main'), { ...idle, isRunning: true }]);
  assert.deepEqual(view.keys(), ['helper']);
});

test('a finished subagent tab that the user did not close is still there after a restart', t => {
  const store = memoryStore();
  const idle = session('helper', { auxiliaryParentId: 'main', auxiliaryKind: 'subagent' });
  const first = tabs([session('main'), { ...idle, isRunning: true }], 'main', store);
  first.setSessions([session('main'), idle]);
  assert.deepEqual(first.keys(), ['helper']);
  first.dispose();
  const restarted = tabs([session('main'), idle], 'main', store);
  t.after(restarted.dispose);
  assert.deepEqual(restarted.keys(), ['helper']);
  restarted.tabs.forget('local:helper');
  const again = tabs([session('main'), idle], 'main', store);
  t.after(again.dispose);
  assert.deepEqual(again.keys(), []);
});

test('a chat that a command opened has a tab before the session list has it, and is selected and shown', t => {
  const view = tabs([session('main')]);
  t.after(view.dispose);
  view.tabs.openAuxiliary(session('fresh', { auxiliaryParentId: 'main', auxiliaryKind: 'btw' }), { requestId: 'request', initialPrompt: 'Why?' });
  assert.deepEqual(view.keys(), ['fresh']);
  assert.equal(view.tabs.selected().key, 'local:fresh');
  assert.equal(view.tabs.shown(), true);
  assert.equal(view.tabs.opening('local:fresh').initialPrompt, 'Why?');
  view.setSessions([session('main'), session('fresh', { auxiliaryParentId: 'main', auxiliaryKind: 'btw', name: 'btw main' })]);
  assert.deepEqual(view.tabs.tabs().map(tab => tab.label), ['btw main']);
});
