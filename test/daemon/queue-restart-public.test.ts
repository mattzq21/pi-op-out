import { expect, test } from 'bun:test';
import { startDaemon, type TestDaemon } from './harness';
import { scriptedModel } from './scripted-model';
import { text } from './agent-chats';

const command = (daemon: TestDaemon, runtimeId: string, value: any) => daemon.invoke('pi_command', { runtimeId, command: value });
const messages = async (daemon: TestDaemon, runtimeId: string) => (await command(daemon, runtimeId, { type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
const pending = (daemon: TestDaemon, runtimeId: string) => daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'queue_update').at(-1)?.payload.event.pendingMessages ?? [];

test('a message waiting when the daemon stops is kept after the restart and sent only when the user retries it', async () => {
  let release!: (reply: { text: string }) => void;
  const busy = new Promise<{ text: string }>(resolve => { release = resolve; });
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const first = await startDaemon();
  const model = await scriptedModel(first.home, request => {
    const last = text(request.messages.at(-1));
    if (last === 'Long job') { started(); return busy; }
    return { text: 'Handled: ' + last };
  });
  let second: TestDaemon | undefined;
  try {
    const chat = await first.invoke('create_temporary_chat', { hostId: 'local' });
    await first.invoke('start_pi', { runtimeId: 'before', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    await command(first, 'before', { type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    await command(first, 'before', { type: 'prompt', message: 'Long job' });
    await modelStarted;
    expect(await command(first, 'before', { type: 'follow_up', message: 'Queued before restart' })).toEqual({ disposition: 'queued' });
    await first.stop();
    release({ text: 'never delivered' });

    second = await startDaemon({ home: first.home });
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'after', clientId: 'laptop', cwd: chat.cwd, sessionPath: path });
    await second.waitEvent('pi://event', payload => payload.runtimeId === 'after' && payload.event?.type === 'queue_update' && payload.event.pendingMessages?.length === 1);
    expect((await command(second, 'after', { type: 'get_state' })).isStreaming).toBe(false);
    expect(model.requests).toHaveLength(1);
    expect(pending(second, 'after')).toEqual([{ retry: true, id: expect.any(String), message: 'Queued before restart', behavior: 'followUp' }]);
    expect((await messages(second, 'after')).map(text)).not.toContain('Queued before restart');

    const seen = new Set(second.events.map(event => event.payload));
    await command(second, 'after', { type: 'change_pending', id: pending(second, 'after')[0].id, action: 'followUp' });
    await second.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === 'after' && payload.event?.type === 'agent_settled');
    expect(text((await messages(second, 'after')).at(-1))).toBe('Handled: Queued before restart');
    expect((await messages(second, 'after')).filter((message: any) => message.role === 'user').map(text)).toEqual(['Long job', 'Queued before restart']);
    expect(pending(second, 'after')).toEqual([]);
  } finally { await second?.stop(); await first.stop(); await model.close(); }
}, 120000);
