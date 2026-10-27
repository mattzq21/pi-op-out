import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
import { startDaemon } from './harness';

const preview = (daemon: { invoke(command: string, args?: any): Promise<any> }, sessionId: string) =>
  daemon.invoke('broker_request', { hostId: 'local', path: '/orchestration', body: { action: 'preview', sessionId, hostId: 'local' } });
const shown = (snapshot: any) => snapshot.history.entries.filter((entry: any) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role)).map((entry: any) => text(entry.message));

test('a chat whose Pi is not running shows its saved history before Pi has started', async () => {
  const agents = await agentDaemon();
  agents.scripts.set('Name the comet', () => ({ text: 'Call it Halley.' }));
  let fresh: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Name the comet' });
    await chat.until(history => text(history.at(-1)) === 'Call it Halley.');
    await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
    await agents.daemon.stop();
    fresh = await startDaemon({ home: agents.daemon.home });
    let started = false;
    const starting = fresh.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId }).then(() => { started = true; }, error => error as Error);
    const saved = await preview(fresh, chat.sessionId);
    expect(started).toBe(false);
    expect(shown(saved)).toEqual(['Name the comet', 'Call it Halley.']);
    expect(await starting).toBeUndefined();
    expect(shown(await preview(fresh, chat.sessionId))).toEqual(['Name the comet', 'Call it Halley.']);
  } finally { await fresh?.stop(); await agents.close(); }
}, 120000);

