import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { act, installDom, renderComponent } from '../dom.mjs';
import { Composer } from '../../clients/ui/components/Composer.tsx';
import { createGoalControls } from '../../clients/ui/components/GoalControls.tsx';

let dom, view, dispose;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dispose?.(); dom.restore(); });

/** The goal status text as the daemon's goal extension publishes it. */
const goal = (fields = {}) => JSON.stringify({ id: 'goal-1', sessionId: 'chat-1', objective: 'Ship the parser', status: 'active', ...fields });
const goalEntry = { id: 'goal', message: 'Ship the parser', behavior: 'followUp', goal: true };
const control = label => document.querySelector(`[aria-label="${label}"]`);
const click = element => act(async () => element.click());

/** A composer whose goal status, disabled state and goal command can change. */
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

test('the goal queue entry pauses, edits and clears the goal, and a paused goal shows as its own entry that resumes', async () => {
  const chat = await goalComposer();
  assert.match(document.querySelector('.pending-goal').textContent, /Ship the parser/);
  await click(control('Pause goal'));
  await act(() => chat.set({ value: goal({ status: 'paused' }) }));
  await chat.rerender({ pendingMessages: [], queued: 0 });
  assert.match(control('Paused goal').textContent, /Paused · Ship the parser/);
  await click(control('Resume goal'));
  await click(control('Edit goal'));
  await click(control('Clear goal'));
  assert.deepEqual(chat.sent, ['pause', 'resume', 'edit', 'clear']);
});

test('a finished goal shows no entry, and the goal buttons are blocked while the chat belongs elsewhere', async () => {
  const chat = await goalComposer({ value: goal({ status: 'complete' }), pendingMessages: [] });
  assert.equal(document.querySelector('.pending-goal'), null);
  await act(() => chat.set({ value: goal({ status: 'paused' }), disabled: true }));
  assert.deepEqual(['Clear goal', 'Resume goal', 'Edit goal'].map(label => control(label).disabled), [true, true, true]);
});

test('a failed goal command is shown under the queue, and the buttons work again afterwards', async () => {
  let fail = true;
  const chat = await goalComposer({ command: async () => { if (fail) throw new Error('Take ownership of this conversation before changing it'); } });
  await click(control('Pause goal'));
  assert.equal(document.querySelector('.pending-goal-error').textContent, 'Take ownership of this conversation before changing it');
  fail = false;
  await click(control('Pause goal'));
  assert.equal(document.querySelector('.pending-goal-error'), null);
  assert.deepEqual(chat.sent, ['pause', 'pause']);
});

test('a goal status the app cannot read is reported, not hidden', async () => {
  await goalComposer({ value: goal({ status: 'waiting' }), pendingMessages: [] });
  assert.match(document.querySelector('.pending-goal-error')?.textContent ?? '', /^Could not show the goal: /);
});
