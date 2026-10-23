import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
import { startDaemon } from './harness';

test('a renamed chat shows its new name in the chat list, for other connections too, and keeps it after a restart', async () => {
  const agents = await agentDaemon();
  let next: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    agents.scripts.set('Plan the release', () => ({ text: 'Release plan ready.' }));
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Plan the release' });
    await chat.until(history => text(history.at(-1)) === 'Release plan ready.');
    const phone = await agents.daemon.connect();
    const named = async (client: { invoke(command: string, args?: any): Promise<any> }) => (await client.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId)?.name;

    // The other connection is told that the list changed, so it reloads it instead of polling.
    const told = phone.waitEvent('pi://sessions-changed');
    await chat.command({ type: 'set_session_name', name: 'Release 2.0 plan' });
    await told;
    expect(await named(phone)).toBe('Release 2.0 plan');
    phone.close();

    await agents.daemon.stop();
    next = await startDaemon({ home: agents.daemon.home });
    expect(await named(next)).toBe('Release 2.0 plan');
  } finally { await next?.stop(); await agents.close().catch(() => {}); }
}, 120000);
