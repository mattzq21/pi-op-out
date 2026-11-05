import { expect, test } from 'bun:test';
import { SessionQueue } from '../../daemon/src/host/queue/queue';

// Pi calls back into the queue while it stops: a pull still in flight from its loop, then the release of unused messages.
function chat() {
  const commands: any[] = [];
  const answers: any[] = [];
  let queue!: SessionQueue;
  queue = new SessionQueue({
    execute: async command => {
      commands.push(command);
      if (command.type === 'abort' && commands.filter(entry => entry.type === 'abort').length === 1) {
        answers.push(await queue.runtimeEvent('queue_take', { behavior: 'followUp', holding: [] }));
        await queue.runtimeEvent('queue_release', { ids: [] });
      }
      return null;
    },
    publish: () => {}, queueHeld: async () => {},
  });
  const take = async () => (await queue.runtimeEvent('queue_take', { behavior: 'followUp', holding: [] })).item;
  return { queue, commands, answers, take };
}

test('Stop does not wait for Pi to answer its own queue requests, and gives Pi no new message', async () => {
  const { queue, commands, answers, take } = chat();
  await queue.command({ type: 'follow_up', message: 'First' });
  expect((await take())?.message).toBe('First');
  await queue.command({ type: 'follow_up', message: 'Second' });
  const started = performance.now();
  await queue.command({ type: 'abort' });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(commands.some(command => command.type === 'force_stop')).toBe(false);
  expect(answers[0].item).toBeNull();
  expect(queue.view().held).toBe(true);
});

test('an interrupted delegation stops without a forced stop and then offers the waiting message again', async () => {
  const { queue, commands, answers, take } = chat();
  await queue.command({ type: 'follow_up', message: 'First' });
  expect((await take())?.message).toBe('First');
  await queue.command({ type: 'follow_up', message: 'Second' });
  const started = performance.now();
  await queue.interruptDelegation();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(commands.some(command => command.type === 'force_stop')).toBe(false);
  expect(answers[0].item).toBeNull();
  await queue.flush();
  expect(commands.filter(command => command.type === 'queue_offer').at(-1)).toMatchObject({ followUp: 1 });
  expect((await take())?.message).toBe('Second');
});
