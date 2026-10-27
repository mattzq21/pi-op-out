import { expect, test } from 'bun:test';
import { SessionQueue } from '../../daemon/src/host/queue';

/** A queue whose Pi holds the given messages in its follow-up queue, as Pi does when it keeps running across a daemon restart. */
function queueWithPi(pending: any[], piFollowUps: string[]) {
  const events: any[] = [];
  const commands: any[] = [];
  const queue = new SessionQueue({
    execute: async command => {
      commands.push(command);
      if (command.type === 'clear_queue') return { steering: [], followUp: piFollowUps.splice(0) };
      return null;
    },
    publish: event => { events.push(event); },
    queueHeld: async () => {},
  }, pending);
  const view = () => events.filter(event => event.type === 'queue_update').at(-1);
  return { queue, view, commands };
}

const retried = (id: string, message: string) => ({ id, message, behavior: 'followUp', retry: true, deliveryStarted: true });

test('a message marked for retry that Pi still holds is shown as queued again, so it is not sent twice', async () => {
  const { queue, view } = queueWithPi([retried('1', 'Check the logs'), retried('2', 'Already answered')], ['Check the logs']);
  await queue.receive({ type: 'queue_update', steering: [], followUp: ['Check the logs'] });
  expect(view().pendingMessages.map((item: any) => [item.id, item.message, item.retry])).toEqual([['1', 'Check the logs', false], ['2', 'Already answered', true]]);
});

test('holding the queue takes back what Pi holds without copies, and those messages can be moved', async () => {
  const { queue, view } = queueWithPi([retried('1', 'a'), retried('2', 'dfw')], ['a', 'dfw']);
  await queue.receive({ type: 'queue_update', steering: [], followUp: ['a', 'dfw'] });
  await queue.command({ type: 'hold_queue', held: true });
  expect(view().held).toBe(true);
  expect(view().pendingMessages.map((item: any) => [item.id, item.message, item.retry ?? false, item.held])).toEqual([['1', 'a', false, true], ['2', 'dfw', false, true]]);
  await queue.changePending('2', 'moveUp');
  expect(view().pendingMessages.map((item: any) => item.message)).toEqual(['dfw', 'a']);
});
