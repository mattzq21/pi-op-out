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
  const first = await startDaemon();
  const model = await scriptedModel(first.home, request => {
    const last = text(request.messages.at(-1));
    return last === 'Long job' ? busy : { text: 'Handled: ' + last };
  });
  let second: TestDaemon | undefined;
  try {
    const chat = await first.invoke('create_temporary_chat', { hostId: 'local' });
    await first.invoke('start_pi', { runtimeId: 'before', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    await command(first, 'before', { type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    await command(first, 'before', { type: 'prompt', message: 'Long job' });
    while (!model.requests.some(request => text(request.messages.at(-1)) === 'Long job')) await Bun.sleep(100);
    expect(await command(first, 'before', { type: 'follow_up', message: 'Queued before restart' })).toEqual({ disposition: 'queued' });
    await first.stop();
    release({ text: 'never delivered' });

    second = await startDaemon({ home: first.home });
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'after', clientId: 'laptop', cwd: chat.cwd, sessionPath: path });
    for (let tries = 0; !pending(second, 'after').length && tries < 50; tries++) await Bun.sleep(100);
    await Bun.sleep(2000);
    expect(pending(second, 'after')).toEqual([{ retry: true, id: expect.any(String), message: 'Queued before restart', behavior: 'followUp' }]);
    expect((await messages(second, 'after')).map(text)).not.toContain('Queued before restart');

    await command(second, 'after', { type: 'change_pending', id: pending(second, 'after')[0].id, action: 'followUp' });
    for (let tries = 0; text((await messages(second, 'after')).at(-1)) !== 'Handled: Queued before restart' && tries < 100; tries++) await Bun.sleep(100);
    expect((await messages(second, 'after')).filter((message: any) => message.role === 'user').map(text)).toEqual(['Long job', 'Queued before restart']);
    expect(pending(second, 'after')).toEqual([]);
  } finally { await second?.stop(); await first.stop(); await model.close(); }
}, 120000);
