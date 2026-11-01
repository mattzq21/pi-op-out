import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { act, installDom, renderComponent } from '../dom.mjs';
import { Composer } from '../../clients/ui/components/Composer.tsx';
import { createGoalControls } from '../../clients/ui/components/GoalControls.tsx';

let dom, view, dispose;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dispose?.(); dom.restore(); });

const goal = (fields = {}) => JSON.stringify({ id: 'goal-1', sessionId: 'chat-1', objective: 'Ship the parser', status: 'active', ...fields });
const goalEntry = { id: 'goal', message: 'Ship the parser', behavior: 'followUp', goal: true };
const control = label => document.querySelector(`[aria-label="${label}"]`);
const click = element => act(async () => element.click());

async function goalComposer({ value = goal(), pendingMessages = [goalEntry], disabled = false, command = async () => {} } = {}) {
  const sent = [];
  let set;
  const controls = createRoot(stop => {
    dispose = stop;
    const [state, setState] = createSignal({ value, disabled, command });
    set = next => setState(current => ({ ...current, ...next }));
    return createGoalControls(() => ({ value: state().value, disabled: state().disabled, onCommand: async action => { sent.push(action); await state().command(action); } }));
  });
  const props = { streaming: true, queued: pendingMessages.length, pendingMessages, commands: [], agents: [], models: [], model: null, thinkingLevel: 'off', thinkingLevels: ['off'], goal: controls,
    onChangePending: async () => {}, onSend: async () => {}, onAbort: async () => {}, onAgent: () => {}, onModel: () => {}, onThinking: () => {}, onToggleFastMode: async () => {} };
  view = await renderComponent(Composer, props);
  return { sent, set, rerender: extra => view.rerender({ ...props, ...extra }) };
}

test('the goal queue entry edits and clears the goal and keeps its place in the queue', async () => {
  const chat = await goalComposer({ pendingMessages: [{ id: '1', message: 'Check the tests', behavior: 'followUp' }, goalEntry, { id: '2', message: 'Then deploy', behavior: 'followUp' }] });
  const texts = [...document.querySelectorAll('.pending-message-text')].map(element => element.textContent);
  assert.deepEqual(texts, ['Check the tests', 'Goal · Ship the parser', 'Then deploy']);
  assert.equal(control('Pause goal'), null);
  await click(control('Edit goal'));
  await click(control('Clear goal'));
  assert.deepEqual(chat.sent, ['edit', 'clear']);
});

test('a finished goal shows no entry, and the goal buttons are blocked while the chat belongs elsewhere', async () => {
  const chat = await goalComposer({ value: goal({ status: 'complete' }), pendingMessages: [] });
  assert.equal(document.querySelector('.pending-goal'), null);
  await act(() => chat.set({ value: goal(), disabled: true }));
  await chat.rerender({ pendingMessages: [goalEntry], queued: 1 });
  assert.deepEqual(['Clear goal', 'Edit goal'].map(label => control(label).disabled), [true, true]);
});

test('a failed goal command is shown under the queue, and the buttons work again afterwards', async () => {
  let fail = true;
  const chat = await goalComposer({ command: async () => { if (fail) throw new Error('Take ownership of this conversation before changing it'); } });
  await click(control('Clear goal'));
  assert.equal(document.querySelector('.pending-goal-error').textContent, 'Take ownership of this conversation before changing it');
  fail = false;
  await click(control('Clear goal'));
  assert.equal(document.querySelector('.pending-goal-error'), null);
  assert.deepEqual(chat.sent, ['clear', 'clear']);
});

test('a goal status the app cannot read is reported, not hidden', async () => {
  await goalComposer({ value: goal({ status: 'waiting' }), pendingMessages: [] });
  assert.match(document.querySelector('.pending-goal-error')?.textContent ?? '', /^Could not show the goal: /);
});
