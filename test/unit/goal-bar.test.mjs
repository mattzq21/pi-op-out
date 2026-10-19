import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act, installDom, renderComponent } from '../dom.mjs';
import { GoalBar } from '../../clients/ui/components/GoalBar.tsx';

let dom, view;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

/** The goal status text as the daemon's goal extension publishes it. */
const goal = (fields = {}) => JSON.stringify({ id: 'goal-1', sessionId: 'chat-1', objective: 'Ship the parser', status: 'active', ...fields });
const control = label => document.querySelector(`[aria-label="${label}"]`);
const click = element => act(async () => element.click());

test('the goal bar shows the goal and sends pause, resume, edit and clear for it', async () => {
  const sent = [];
  view = await renderComponent(GoalBar, { value: goal(), disabled: false, onCommand: async action => { sent.push(action); } });
  const bar = control('Conversation goal');
  assert.match(bar.textContent, /Ship the parser/);
  await click(control('Pause goal'));
  await view.rerender({ value: goal({ status: 'paused' }), disabled: false, onCommand: async action => { sent.push(action); } });
  await click(control('Resume goal'));
  await click(control('Edit goal'));
  await click(control('Clear goal'));
  assert.deepEqual(sent, ['pause', 'resume', 'edit', 'clear']);
});

test('the goal bar hides a finished goal and blocks its buttons while the chat belongs elsewhere', async () => {
  view = await renderComponent(GoalBar, { value: goal({ status: 'complete' }), disabled: false, onCommand: async () => {} });
  assert.equal(control('Conversation goal'), null);
  await view.rerender({ value: goal({ status: 'paused' }), disabled: true, onCommand: async () => { throw new Error('must not run'); } });
  assert.deepEqual(['Clear goal', 'Resume goal', 'Edit goal'].map(label => control(label).disabled), [true, true, true]);
});

test('a failed goal command is shown, and the buttons work again afterwards', async () => {
  let fail = true;
  const sent = [];
  view = await renderComponent(GoalBar, { value: goal(), disabled: false, onCommand: async action => { sent.push(action); if (fail) throw new Error('Take ownership of this conversation before changing it'); } });
  await click(control('Pause goal'));
  assert.equal(document.querySelector('.goal-bar [role="alert"]').textContent, 'Take ownership of this conversation before changing it');
  fail = false;
  await click(control('Pause goal'));
  assert.equal(document.querySelector('.goal-bar [role="alert"]'), null);
  assert.deepEqual(sent, ['pause', 'pause']);
});

test('a goal status the app cannot read is reported, not hidden', async () => {
  view = await renderComponent(GoalBar, { value: goal({ status: 'waiting' }), disabled: false, onCommand: async () => {} });
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /^Could not show the goal: /);
});
