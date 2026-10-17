import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

/** Sends a message the way the composer does: through the queue, with the draft's submission ID. */
const send = (chat: Awaited<ReturnType<typeof agents.rootChat>>, message: string) => chat.command({ type: 'follow_up', message, goalSubmissionId: crypto.randomUUID() });
const turnsSoFar = (messages: any[]) => messages.filter(message => message.role === 'assistant' && text(message) === 'Still writing.').length;
const notices = (runtimeId: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.method === 'notify').map(event => event.payload.event.message);

test('a goal needs the goal tools, and without them the user is told how to enable them', async () => {
  const chat = await agents.rootChat();
  expect(await send(chat, '/goal Write the report')).toBe(false);
  expect(notices(chat.runtimeId)).toContain('Enable get_goal, create_goal and update_goal for this agent under Settings → Agents → Tools before starting a goal.');
  expect(await chat.history()).toEqual([]);
}, 60000);

test('a goal keeps the agent working turn after turn until the agent marks it complete', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  agents.scripts.set('Write the report', messages => {
    if (called(messages, 'update_goal')) return { text: 'Report finished.' };
    return turnsSoFar(messages) < 2 ? { text: 'Still writing.' } : { tool: 'update_goal', arguments: { status: 'complete' } };
  });
  const chat = await agents.rootChat();
  await send(chat, '/goal Write the report');
  const messages = await chat.until(history => text(history.at(-1)) === 'Report finished.');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Still writing.', 'Still writing.', 'Report finished.']);
  await Bun.sleep(1500);
  expect(text((await chat.history()).at(-1))).toBe('Report finished.');
}, 120000);

test('pausing a goal stops the extra turns, and resuming starts them again', async () => {
  await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
  let finish = false;
  agents.scripts.set('Keep polishing', async messages => {
    await Bun.sleep(200);
    if (called(messages, 'update_goal')) return { text: 'Polished.' };
    return finish ? { tool: 'update_goal', arguments: { status: 'complete' } } : { text: 'Polishing.' };
  });
  const chat = await agents.rootChat();
  const turns = async () => (await chat.history()).filter(message => message.role === 'assistant' && text(message) === 'Polishing.').length;
  await send(chat, '/goal Keep polishing');
  await chat.until(history => history.filter(message => text(message) === 'Polishing.').length >= 2);
  expect(await send(chat, '/goal pause')).toEqual({ disposition: 'handled' });
  await Bun.sleep(1000);
  const paused = await turns();
  await Bun.sleep(1500);
  expect(await turns()).toBe(paused);
  finish = true;
  await send(chat, '/goal resume');
  await chat.until(history => text(history.at(-1)) === 'Polished.');
}, 120000);
