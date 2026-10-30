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


test('the preview of a chat whose Pi is not running shows its saved queue and the outline of its older answers', async () => {
  const agents = await agentDaemon();
  agents.scripts.set('Question', messages => ({ text: 'Answer to ' + text(messages.at(-1)) + ' ' + 'x'.repeat(2000) }));
  try {
    const chat = await agents.rootChat();
    for (let index = 0; index < 7; index++) {
      await chat.command({ type: 'prompt', message: 'Question ' + index });
      await chat.until(history => text(history.at(-1)).startsWith('Answer to Question ' + index));
    }
    await chat.command({ type: 'hold_queue', held: true });
    await chat.command({ type: 'follow_up', message: 'Later question', goalSubmissionId: crypto.randomUUID() });
    await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
    const saved = await preview(agents.daemon, chat.sessionId);
    expect(saved.queue.pendingMessages.map((item: any) => item.message)).toEqual(['Later question']);
    expect(saved.state.queueHeld).toBe(true);
    expect(saved.history.outline.map((item: any) => item.preview.slice(0, 20))).toEqual(['Answer to Question 0', 'Answer to Question 1']);
  } finally { await agents.close(); }
}, 120000);
