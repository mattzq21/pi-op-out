import { expect, test } from 'bun:test';
import { SessionQueue } from '../../daemon/src/host/queue';

const status = (value: string) => ({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'piop-goal', statusText: JSON.stringify({ id: 'goal-1', objective: 'Build', status: value }) });

for (const restored of [false, true]) test(`a ${restored ? 'restored' : 'newly'} paused goal lets the next message be taken`, async () => {
  const queue = new SessionQueue({ execute: async () => null, publish: () => {}, queueHeld: async () => {} });
  await queue.receive(status(restored ? 'paused' : 'active'));
  await queue.drain();
  await queue.command({ type: 'follow_up', message: 'Next message' });
  if (!restored) {
    expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item).toBeNull();
    await queue.receive(status('paused'));
    await queue.drain();
  }
  expect(queue.view().held).toBe(false);
  expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item?.message).toBe('Next message');
});

test('a queue hold stays separate from goal pause and resume', async () => {
  const commands: any[] = [];
  const queue = new SessionQueue({ execute: async command => { commands.push(command); return null; }, publish: () => {}, queueHeld: async () => {} });
  await queue.receive(status('active'));
  await queue.drain();
  await queue.command({ type: 'follow_up', message: 'Next message' });
  await queue.command({ type: 'hold_queue', held: true });
  await queue.receive(status('paused'));
  await queue.drain();
  expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item).toBeNull();
  await queue.receive(status('active'));
  await queue.drain();
  expect(queue.view().held).toBe(true);
  await queue.receive(status('paused'));
  await queue.drain();
  await queue.command({ type: 'hold_queue', held: false });
  expect(commands.some(command => command.message === '/goal resume')).toBe(false);
  expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item?.message).toBe('Next message');
});

test('resuming a goal blocks messages still below it', async () => {
  const queue = new SessionQueue({ execute: async () => null, publish: () => {}, queueHeld: async () => {} });
  await queue.receive(status('paused'));
  await queue.drain();
  await queue.command({ type: 'follow_up', message: 'Next message' });
  await queue.receive(status('active'));
  await queue.drain();
  expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item).toBeNull();
});

test('saved messages wait until the goal status is restored', async () => {
  const queue = new SessionQueue({ execute: async () => null, publish: () => {}, queueHeld: async () => {} }, [
    { id: '1', message: 'Next message', behavior: 'followUp', afterGoal: true },
  ]);
  expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item).toBeNull();
  await queue.receive(status('paused'));
  await queue.drain();
  expect((await queue.runtimeEvent('queue_take', { behavior: 'followUp' })).item?.message).toBe('Next message');
});
