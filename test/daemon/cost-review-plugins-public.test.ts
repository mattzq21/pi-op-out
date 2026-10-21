import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
import type { Client } from './harness';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60_000);
afterAll(async () => { await agents?.close(); });

const ALL = ['cost', 'review'];
const REVIEW = '__pi_desktop_review__';
let runtimes = 0;

/** Restarts the daemon with the given plugins, as Settings → Plugins does, and returns a new connection to it. */
async function restartWith(client: Client, enabled: string[]): Promise<Client> {
  const status = await client.invoke('plugin_status', { hostId: 'local' });
  const { restartId } = await client.invoke('restart_daemon', { hostId: 'local', enabled, revision: status.revision, closeTerminals: true });
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await Bun.sleep(300)) {
    const result = await agents.daemon.connect().then(next => next.invoke('daemon_restart_status', { hostId: 'local', restartId }).finally(() => next.close())).catch(() => undefined);
    if (result && ['complete', 'rolled_back', 'failed'].includes(result.phase)) {
      expect(result).toMatchObject({ phase: 'complete', error: null });
      const next = await agents.daemon.connect();
      expect(await next.invoke('plugin_status', { hostId: 'local' })).toMatchObject({ enabled, configured: enabled, error: null });
      return next;
    }
  }
  throw new Error('The daemon restart never ended');
}

/** Opens a chat in a shown window over client: a new one, or the saved one with sessionId. */
async function openChat(client: Client, saved?: { sessionId: string; cwd: string }) {
  const chat = saved ?? await client.invoke('create_temporary_chat', { hostId: 'local' });
  const runtimeId = 'plugins-' + ++runtimes;
  await client.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId, presence: { visible: true, focused: true } });
  const command = (value: any) => client.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
  const failure = (value: any) => command(value).then(() => 'sent', (error: Error) => error.message);
  const commands = async () => (await command({ type: 'get_commands' })).commands.map((item: any) => item.name);
  const notice = (match: (message: string) => boolean) => client.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.method === 'notify' && match(payload.event.message), 30_000);
  /** The next review this chat opens that matches. */
  const review = (match: (review: any) => boolean) => client.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.title === REVIEW && match(JSON.parse(payload.event.placeholder)), 30_000).then(payload => JSON.parse(payload.event.placeholder));
  /** The cost limit this chat shows above the composer. */
  const costStatus = (match: (text: string) => boolean) => client.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.method === 'setStatus' && payload.event.statusKey === 'piop-session-cost' && typeof payload.event.statusText === 'string' && match(payload.event.statusText), 30_000);
  const costStatuses = () => client.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.statusKey === 'piop-session-cost');
  const owned = async () => (await commands()).filter((name: string) => ['cost', 'review', 'rs'].includes(name)).sort();
  return { sessionId: chat.sessionId as string, cwd: chat.cwd as string, command, failure, commands, owned, notice, review, costStatus, costStatuses };
}

const catalog = async (client: Client) => (await client.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } })).commands;
const modelSaw = (words: string) => agents.model.requests.some(request => request.messages.some((message: any) => text(message).includes(words)));

test('cost and review are plugins: enabled by default, gone with an explicit error when disabled, and back unchanged when enabled again', async () => {
  agents.scripts.set('Plugin chat', () => ({ text: 'Plugin chat ready.' }));
  let client: Client = agents.daemon;
  expect(await client.invoke('plugin_status', { hostId: 'local' })).toMatchObject({ enabled: ALL, configured: ALL, error: null });
  // No chat ran on this host yet, so the catalog starts a short Pi run for the command hints.
  const fresh = await client.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
  expect(fresh.commandDetails.find((item: any) => item.name === 'review').options).toEqual([{ value: '', label: '[scope]', description: expect.stringContaining('limits the review') }]);
  expect(await catalog(client)).toEqual(expect.arrayContaining(['cost', 'review', 'rs']));

  const first = await openChat(client);
  expect(await first.commands()).toEqual(expect.arrayContaining(['cost', 'review', 'rs']));
  const listed = (await first.command({ type: 'get_commands' })).commands;
  expect(listed.find((item: any) => item.name === 'rs').options).toEqual([{ value: '', label: '[n] [scope]', description: expect.stringContaining('review subagents') }]);
  expect(listed.find((item: any) => item.name === 'review').options).toEqual([{ value: '', label: '[scope]', description: expect.stringContaining('limits the review') }]);
  const draft = await client.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
  expect(draft.commandDetails.find((item: any) => item.name === 'rs').options).toEqual([{ value: '', label: '[n] [scope]', description: expect.stringContaining('review subagents') }]);
  await first.command({ type: 'prompt', message: 'Plugin chat' });
  const replied = async () => (await first.command({ type: 'get_entries' })).entries.some((entry: any) => entry.type === 'message' && text(entry.message) === 'Plugin chat ready.');
  for (let tries = 0; !(await replied()) && tries < 300; tries++) await Bun.sleep(100);
  expect(await replied()).toBe(true);
  const limited = first.notice(message => message.startsWith('Session cost limit set to $5.00'));
  await first.command({ type: 'prompt', message: '/cost 5' });
  await limited;
  const opened = first.review(review => review.task?.includes('before.ts'));
  await first.command({ type: 'follow_up', message: '/review before.ts' });
  const saved = await opened;
  expect(saved.task).toContain('before.ts');

  client = await restartWith(client, []);
  expect(await catalog(client)).not.toEqual(expect.arrayContaining(['cost']));
  expect((await catalog(client)).filter((name: string) => ['cost', 'review', 'rs'].includes(name))).toEqual([]);
  const disabled = await openChat(client, first);
  expect((await disabled.commands()).filter((name: string) => ['cost', 'review', 'rs'].includes(name))).toEqual([]);
  expect(await disabled.failure({ type: 'prompt', message: '/cost 3' })).toBe('The Cost limit plugin is disabled. Enable it to use /cost.');
  expect(await disabled.failure({ type: 'follow_up', message: '/review after.ts' })).toBe('The Code review plugin is disabled. Enable it to use /review.');
  expect(await disabled.failure({ type: 'steer', message: '/rs 2' })).toBe('The Code review plugin is disabled. Enable it to use /rs.');
  expect(await disabled.failure({ type: 'open_review', reviewId: saved.sessionId })).toBe('The Code review plugin is disabled. Enable it to open reviews.');
  expect(await disabled.failure({ type: 'review_feedback', sessionId: saved.sessionId, message: 'Looks fine' })).toBe('The Code review plugin is disabled. Enable it to send review feedback.');
  for (const words of ['/cost 3', '/review after.ts', '/rs 2', 'Looks fine']) expect(modelSaw(words)).toBe(false);
  expect(disabled.costStatuses()).toEqual([]);

  // Each plugin loads on its own: review without cost, then cost without review.
  client = await restartWith(client, ['review']);
  expect((await catalog(client)).filter((name: string) => ['cost', 'review', 'rs'].includes(name)).sort()).toEqual(['review', 'rs']);
  const reviewOnly = await openChat(client, first);
  expect(await reviewOnly.owned()).toEqual(['review', 'rs']);
  expect(await reviewOnly.failure({ type: 'prompt', message: '/cost 3' })).toBe('The Cost limit plugin is disabled. Enable it to use /cost.');
  const linked = reviewOnly.review(review => review.sessionId === saved.sessionId);
  await reviewOnly.command({ type: 'open_review', reviewId: saved.sessionId });
  expect(await linked).toMatchObject({ sessionId: saved.sessionId, parentSessionId: first.sessionId });
  expect(reviewOnly.costStatuses()).toEqual([]);

  client = await restartWith(client, ['cost']);
  expect((await catalog(client)).filter((name: string) => ['cost', 'review', 'rs'].includes(name))).toEqual(['cost']);
  const costOnly = await openChat(client, first);
  expect(await costOnly.owned()).toEqual(['cost']);
  await costOnly.costStatus(status => status.endsWith(' / $5.00'));
  expect(await costOnly.failure({ type: 'follow_up', message: '/review only-cost.ts' })).toBe('The Code review plugin is disabled. Enable it to use /review.');
  expect(await costOnly.failure({ type: 'open_review', reviewId: saved.sessionId })).toBe('The Code review plugin is disabled. Enable it to open reviews.');
  expect(modelSaw('/review only-cost.ts')).toBe(false);

  client = await restartWith(client, ALL);
  expect(await catalog(client)).toEqual(expect.arrayContaining(['cost', 'review', 'rs']));
  const again = await openChat(client, first);
  expect(await again.commands()).toEqual(expect.arrayContaining(['cost', 'review', 'rs']));
  // The limit saved before cost was disabled is still in force.
  await again.costStatus(status => status.endsWith(' / $5.00'));
  const raised = again.notice(message => message.startsWith('Session cost limit set to $4.00'));
  await again.command({ type: 'prompt', message: '/cost 4' });
  await raised;
  await again.costStatus(status => status.endsWith(' / $4.00'));
  const reopened = again.review(review => review.sessionId === saved.sessionId);
  await again.command({ type: 'open_review', reviewId: saved.sessionId });
  expect(await reopened).toMatchObject({ sessionId: saved.sessionId, parentSessionId: first.sessionId });
  const next = again.review(review => review.task?.includes('again.ts'));
  await again.command({ type: 'follow_up', message: '/review again.ts' });
  expect((await next).task).toContain('again.ts');
  for (const words of ['/cost', '/review']) expect(modelSaw(words)).toBe(false);
}, 400_000);
