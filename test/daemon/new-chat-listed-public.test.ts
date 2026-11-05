import { expect, test } from 'bun:test';
import { agentDaemon } from './agent-chats';

test('a new chat is listed as soon as its first message is saved, before the reply ends', async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('Long task', () => ({ text: 'Working', stall: 'bash' }));
    const chat = await agents.rootChat();
    const { daemon } = agents;
    const isUserEnd = (payload: any) => payload?.runtimeId === chat.runtimeId && payload.event?.type === 'message_end' && payload.event.message?.role === 'user';
    await chat.command({ type: 'prompt', message: 'Long task' });
    await daemon.waitEvent('pi://event', isUserEnd, 30000);
    const saved = daemon.events.findIndex(event => event.event === 'pi://event' && isUserEnd(event.payload));
    for (let tries = 0; !daemon.events.slice(saved).some(event => event.event === 'pi://sessions-changed') && tries < 100; tries++) await Bun.sleep(100);
    expect(daemon.events.slice(saved).some(event => event.event === 'pi://sessions-changed')).toBe(true);
    expect((await daemon.invoke('list_sessions')).some((session: any) => session.id === chat.sessionId)).toBe(true);
    await chat.command({ type: 'abort' });
  } finally { await agents.close().catch(() => {}); }
}, 120000);

test('a turn that starts and ends tells clients that the chat row changed, so its time, preview and cost update', async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('Short task', () => ({ text: 'Done.' }));
    const chat = await agents.rootChat();
    const { daemon } = agents;
    await chat.command({ type: 'prompt', message: 'Short task' });
    const replies = (history: any[]) => history.filter(message => message.role === 'assistant').length;
    await chat.until(history => replies(history) === 1);
    await daemon.waitEvent('pi://session-running', payload => payload?.sessionId === chat.sessionId && payload.running === false, 30000);
    const row = async () => (await daemon.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId);
    const first = await row();
    const before = daemon.events.filter(event => event.event === 'pi://sessions-changed').length;
    await chat.command({ type: 'prompt', message: 'Short task again' });
    await chat.until(history => replies(history) === 2);
    let seen = 0;
    await daemon.waitEvent('pi://sessions-changed', () => ++seen === before + 2, 30000);
    const second = await row();
    expect(second.messageCount).toBeGreaterThan(first.messageCount);
    expect(second.lastMessageAt).toBeGreaterThan(first.lastMessageAt);
  } finally { await agents.close().catch(() => {}); }
}, 120000);
