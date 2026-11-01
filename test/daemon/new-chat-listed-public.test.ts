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
