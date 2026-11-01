import { expect, test } from 'bun:test';
import { startDaemon, type TestDaemon } from './harness';
import { scriptedModel } from './scripted-model';
import { text } from './agent-chats';

const command = (daemon: TestDaemon, runtimeId: string, value: any) => daemon.invoke('pi_command', { runtimeId, command: value });
const messages = async (daemon: TestDaemon, runtimeId: string) => (await command(daemon, runtimeId, { type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
const pending = (daemon: TestDaemon, runtimeId: string) => daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'queue_update').at(-1)?.payload.event.pendingMessages ?? [];

test('a message waiting when the daemon stops waits again after the restart and reaches the agent once, on its own', async () => {
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
    for (let tries = 0; text((await messages(second, 'after')).at(-1)) !== 'Handled: Queued before restart' && tries < 100; tries++) await Bun.sleep(100);
    expect((await messages(second, 'after')).filter((message: any) => message.role === 'user').map(text)).toEqual(['Long job', 'Queued before restart']);
    expect(model.requests.filter(request => text(request.messages.at(-1)) === 'Queued before restart')).toHaveLength(1);
    expect(pending(second, 'after')).toEqual([]);
  } finally { await second?.stop(); await first.stop(); await model.close(); }
}, 120000);
test('a held queue stays on hold after the daemon restarts, and its messages go to the agent only when the user resumes it', async () => {
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
    await command(first, 'before', { type: 'follow_up', message: 'Queued before the hold' });
    await command(first, 'before', { type: 'hold_queue', held: true });
    await command(first, 'before', { type: 'steer', message: 'Held steer' });
    await first.stop();
    release({ text: 'never delivered' });

    second = await startDaemon({ home: first.home });
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'after', clientId: 'laptop', cwd: chat.cwd, sessionPath: path });
    await second.waitEvent('pi://event', payload => payload.runtimeId === 'after' && payload.event?.type === 'queue_update' && payload.event.pendingMessages?.length === 2);
    expect((await command(second, 'after', { type: 'get_state' })).queueHeld).toBe(true);
    expect(pending(second, 'after').map((item: any) => [item.message, item.behavior, item.retry ?? false])).toEqual([['Queued before the hold', 'followUp', false], ['Held steer', 'steer', false]]);
    for (let tries = 0; (await messages(second, 'after')).at(-1)?.role !== 'assistant' && tries < 100; tries++) await Bun.sleep(100);
    expect(model.requests.map(request => text(request.messages.at(-1)))).toEqual(['Long job', 'Long job']);
    expect(pending(second, 'after')).toHaveLength(2);

    const seen = new Set(second.events.map(event => event.payload));
    await command(second, 'after', { type: 'hold_queue', held: false });
    await second.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === 'after' && payload.event?.type === 'queue_update' && payload.event.held === false && payload.event.pendingMessages?.length === 0);
    await second.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === 'after' && payload.event?.type === 'agent_settled');
    for (let tries = 0; text((await messages(second, 'after')).at(-1)) !== 'Handled: Queued before the hold' && tries < 50; tries++) await Bun.sleep(100);
    expect((await messages(second, 'after')).filter((message: any) => message.role === 'user').map(text)).toEqual(['Long job', 'Held steer', 'Queued before the hold']);
    expect((await command(second, 'after', { type: 'get_state' })).queueHeld).toBe(false);
  } finally { await second?.stop(); await first.stop(); await model.close(); }
}, 120000);
