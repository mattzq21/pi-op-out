import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createComponent } from 'solid-js';
import { act, installDom, renderComponent } from '../dom.mjs';
import { SubagentResults, subagentRuns } from '../../clients/ui/components/SubagentResults.tsx';
import { ConversationHostContext, SubagentNavigationContext } from '../../clients/ui/lib/subagentNavigation.ts';

let dom, view;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

/** A run as the daemon delivers it in a piop-subagent-result message. */
const run = (name, status, extra = {}) => ({ version: 1, toolCallId: 'call_1', parentSessionId: 'parent', sessionId: name + '-id', sessionPath: `/sessions/${name}.jsonl`, hostId: 'local', name, task: 'Task for ' + name, status, startedAt: 1, agent: 'general', ...extra });

async function render(details, { host } = {}) {
  const opened = [];
  view = await renderComponent(() => createComponent(SubagentNavigationContext.Provider, { value: target => opened.push(target), get children() {
    return createComponent(ConversationHostContext.Provider, { value: host && (() => host), get children() { return createComponent(SubagentResults, { runs: subagentRuns(details) }); } });
  } }));
  const buttons = () => [...document.querySelectorAll('.subagent-open')];
  return { opened, buttons };
}

test('delegated work shows each child with its state, and a click opens that child chat', async () => {
  const { opened, buttons } = await render({ version: 1, runs: [run('reader', 'completed'), run('writer', 'running'), run('tester', 'cancelled'), run('linter', 'failed')] });
  assert.deepEqual(buttons().map(button => button.getAttribute('aria-label')), [
    'Open reader agent chat — Subagent succeeded', 'Open writer agent chat — Subagent started', 'Open tester agent chat — Subagent cancelled', 'Open linter agent chat — Subagent failed',
  ]);
  await act(async () => buttons()[1].click());
  assert.deepEqual(opened.map(target => [target.name, target.sessionId, target.sessionPath, target.hostId]), [['writer', 'writer-id', '/sessions/writer.jsonl', 'local']]);
});

test('a child chat opens on the machine of the conversation that shows it', async () => {
  const { opened, buttons } = await render({ runs: [run('reader', 'completed')] }, { host: 'server' });
  await act(async () => buttons()[0].click());
  assert.equal(opened[0].hostId, 'server');
});

test('a child that has no saved chat yet cannot be opened, and a malformed run is left out', async () => {
  const { buttons } = await render({ runs: [run('starting', 'running', { sessionId: '', sessionPath: '' }), { name: 'broken' }, run('reader', 'completed')] });
  assert.deepEqual(buttons().map(button => [button.querySelector('.subagent-name').textContent, button.disabled]), [['starting', true], ['reader', false]]);
});
