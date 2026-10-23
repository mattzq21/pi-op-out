import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
import { startDaemon, temporaryDirectory, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop());

/** Waits for a restart to end, as the app does: the daemon is gone for a while, so failed reads are expected. */
async function restartResult(restartId: string, target: TestDaemon = daemon) {
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await Bun.sleep(300)) {
    const result = await target.connect().then(client => client.invoke('daemon_restart_status', { hostId: 'local', restartId }).finally(() => client.close())).catch(() => undefined);
    if (result && ['complete', 'rolled_back', 'failed'].includes(result.phase)) return result;
  }
  throw new Error('The daemon restart never ended');
}

test.concurrent('a plugin change waits for an open terminal and the current setup, then restarts the daemon with only the chosen plugins', async () => {
  const before = await daemon.invoke('plugin_status', { hostId: 'local' });
  expect(before).toMatchObject({ enabled: ['cost', 'review'], error: null });

  expect(await daemon.failure('restart_daemon', { hostId: 'local', enabled: ['review'], revision: 'stale', closeTerminals: false })).toContain('Plugin setup changed in another client');
  expect(await daemon.failure('restart_daemon', { hostId: 'local', enabled: ['review', 'unknown'], revision: before.revision, closeTerminals: true })).toBe('Unknown bundled plugin: unknown');
  expect(await daemon.failure('restart_daemon', { hostId: 'local', enabled: ['review', 'review'], revision: before.revision, closeTerminals: true })).toBe('Duplicate plugin: review');
  await daemon.invoke('start_terminal', { terminalId: 'open-terminal', sessionKey: 'local:restart', cwd: temporaryDirectory('piop-restart-'), cols: 80, rows: 24 });
  expect(await daemon.invoke('restart_daemon', { hostId: 'local', enabled: ['review'], revision: before.revision, closeTerminals: false })).toEqual({ confirmationRequired: 'terminals', terminalCount: 1 });
  expect(await daemon.invoke('plugin_status', { hostId: 'local' })).toEqual(before);

  const { restartId } = await daemon.invoke('restart_daemon', { hostId: 'local', enabled: ['review'], revision: before.revision, closeTerminals: true });
  expect(await restartResult(restartId)).toMatchObject({ phase: 'complete', error: null });
  const client = await daemon.connect();
  const after = await client.invoke('plugin_status', { hostId: 'local' });
  expect(after).toMatchObject({ enabled: ['review'], configured: ['review'], error: null });
  expect(after.revision).not.toBe(before.revision);
}, 180_000);

test.concurrent('a restart waits for a reply in progress, and the finished chat is still there after the restart', async () => {
  const agents = await agentDaemon();
  try {
    const reply = Promise.withResolvers<{ text: string }>();
    const asked = Promise.withResolvers<void>();
    agents.scripts.set('Think slowly', () => { asked.resolve(); return reply.promise; });
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Think slowly' });
    await asked.promise;
    const status = await agents.daemon.invoke('plugin_status', { hostId: 'local' });
    const restart = { hostId: 'local', enabled: status.enabled, revision: status.revision, closeTerminals: false };
    expect(await agents.daemon.failure('restart_daemon', restart)).toBe('Wait for active agents to finish before restarting the daemon');

    reply.resolve({ text: 'Slow answer' });
    await chat.until(history => text(history.at(-1)) === 'Slow answer');
    const { restartId } = await agents.daemon.invoke('restart_daemon', restart);
    expect(await restartResult(restartId, agents.daemon)).toMatchObject({ phase: 'complete', error: null });

    const client = await agents.daemon.connect();
    await client.invoke('start_pi', { runtimeId: 'after-restart', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    const entries = (await client.invoke('pi_command', { runtimeId: 'after-restart', command: { type: 'get_entries' } })).entries;
    const messages = entries.filter((entry: any) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role));
    expect(messages.map((entry: any) => text(entry.message))).toEqual(['Think slowly', 'Slow answer']);
  } finally { await agents.close(); }
}, 180_000);
