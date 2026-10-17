import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, temporaryDirectory, type Client, type TestDaemon } from './harness';

/*
 * Shared terminals belong to a conversation and to the connection that opened them. A client that reconnects with
 * the same client ID takes them over when it lists the terminals of a conversation it owns.
 */
let daemon: TestDaemon;
let cwd: string;

beforeAll(async () => {
  daemon = await startDaemon();
  // Interactive bash reads ~/.bashrc; the terminal directory holds the script that the terminal runs.
  writeFileSync(join(daemon.home, '.bashrc'), '[ -f ./.terminal-script ] && exec sh ./.terminal-script\n');
  cwd = join(temporaryDirectory('piop-shared-terminal-'), 'terminal');
  mkdirSync(cwd);
  writeFileSync(join(cwd, '.terminal-script'), "printf '$ preserved\\n'; exec sleep 60\n");
}, 60_000);
afterAll(() => daemon?.stop());

let runtimes = 0;
/** A saved conversation that the given client owns through a running Pi. */
async function ownedSession(client: Client, clientId: string): Promise<string> {
  const chat = await client.invoke('create_temporary_chat', { hostId: 'local' });
  expect(await client.invoke('start_pi', { runtimeId: 'runtime-' + ++runtimes, clientId, cwd: chat.cwd, sessionId: chat.sessionId })).toMatchObject({ owned: true });
  return chat.sessionId;
}

const shared = (client: Client, clientId: string, action: string, sessionId: string, args: Record<string, unknown> = {}) =>
  client.invoke('shared_terminal', { action, clientId, sessionKey: 'local:' + sessionId, hostId: 'local', ...args });

/** Starts a shared terminal and resolves with the generation of its first output once "$ preserved" has arrived. */
async function startTerminal(client: Client, clientId: string, sessionId: string, terminalId: string): Promise<string> {
  const from = client.events.length;
  await shared(client, clientId, 'start', sessionId, { sharedTerminalId: terminalId, cwd, cols: 80, rows: 24 });
  const output = () => client.events.slice(from).filter(event => event.event === 'pi://event' && event.payload?.type === 'terminal_output' && event.payload.terminalId === terminalId);
  await client.waitEvent('pi://event', () => output().map(event => event.payload.data).join('').includes('$ preserved'));
  return output()[0]!.payload.generation;
}

const entry = async (client: Client, clientId: string, sessionId: string, terminalId: string) =>
  (await shared(client, clientId, 'list', sessionId)).find((item: any) => item.id === terminalId);

test('another connection cannot send and clear the owner terminal draft', async () => {
  const owner = await daemon.connect();
  const other = await daemon.connect();
  const sessionId = 'draft-protected-input';
  const terminalId = 'protected-input';
  try {
    await startTerminal(owner, 'shared-client-id', sessionId, terminalId);
    await shared(owner, 'shared-client-id', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Owner command' });
    expect(await other.failure('shared_terminal', {
      action: 'write_and_clear_draft', clientId: 'shared-client-id', hostId: 'local',
      sessionKey: 'local:' + sessionId, sharedTerminalId: terminalId, data: 'Owner command\n', expectedDraft: 'Owner command',
    })).toBe('Take ownership of this session before changing its terminals');
    expect(await entry(owner, 'shared-client-id', sessionId, terminalId))
      .toMatchObject({ owned: true, exited: false, inputDraft: 'Owner command' });
    await shared(owner, 'shared-client-id', 'write_and_clear_draft', sessionId, {
      sharedTerminalId: terminalId, data: 'Owner command\n', expectedDraft: 'Owner command',
    });
    expect((await entry(owner, 'shared-client-id', sessionId, terminalId)).inputDraft).toBe('');
  } finally {
    await shared(owner, 'shared-client-id', 'close', sessionId, { sharedTerminalId: terminalId });
    owner.close(); other.close();
  }
}, 30_000);

test('oversized Unicode terminal drafts are rejected without losing the saved draft', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-size-limit';
  const terminalId = 'size-limit';
  try {
    await startTerminal(client, 'size-owner', sessionId, terminalId);
    await shared(client, 'size-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Keep this command' });
    expect(await client.failure('shared_terminal', {
      action: 'draft', clientId: 'size-owner', hostId: 'local', sessionKey: 'local:' + sessionId,
      sharedTerminalId: terminalId, data: '🦆'.repeat(262145),
    })).toBe('Terminal draft exceeds 1 MiB');
    expect((await entry(client, 'size-owner', sessionId, terminalId)).inputDraft).toBe('Keep this command');

    const limit = '🦆'.repeat(262144);
    await shared(client, 'size-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: limit });
    expect((await entry(client, 'size-owner', sessionId, terminalId)).inputDraft).toBe(limit);
  } finally {
    await shared(client, 'size-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('discarding drafts closes only the requesting connection terminals', async () => {
  const first = await daemon.connect();
  const second = await daemon.connect();
  try {
    await startTerminal(first, 'same-client', 'draft-cleanup', 'cleanup-first');
    const generation = await startTerminal(second, 'same-client', 'draft-other-cleanup', 'cleanup-second');
    await shared(first, 'same-client', 'discard_drafts', 'draft-cleanup');
    expect(await shared(first, 'same-client', 'list', 'draft-cleanup')).toEqual([]);
    expect(await entry(second, 'same-client', 'draft-other-cleanup', 'cleanup-second'))
      .toMatchObject({ owned: true, exited: false, generation, output: expect.stringContaining('$ preserved') });
  } finally {
    await shared(first, 'same-client', 'close', 'draft-cleanup', { sharedTerminalId: 'cleanup-first' });
    await shared(second, 'same-client', 'close', 'draft-other-cleanup', { sharedTerminalId: 'cleanup-second' });
    first.close(); second.close();
  }
}, 30_000);

test('discarding drafts keeps terminals attached to saved chats on the same connection', async () => {
  const client = await daemon.connect();
  const clientId = 'saved-cleanup-owner';
  const sessionId = await ownedSession(client, clientId);
  try {
    const generation = await startTerminal(client, clientId, sessionId, 'saved-cleanup-terminal');
    await startTerminal(client, clientId, 'draft-saved-cleanup', 'saved-cleanup-draft');
    await shared(client, clientId, 'discard_drafts', 'draft-saved-cleanup');
    expect(await shared(client, clientId, 'list', 'draft-saved-cleanup')).toEqual([]);
    expect(await entry(client, clientId, sessionId, 'saved-cleanup-terminal'))
      .toMatchObject({ owned: true, exited: false, generation, output: expect.stringContaining('$ preserved') });
  } finally {
    await shared(client, clientId, 'close', sessionId, { sharedTerminalId: 'saved-cleanup-terminal' });
    await shared(client, clientId, 'close', 'draft-saved-cleanup', { sharedTerminalId: 'saved-cleanup-draft' });
    client.close();
  }
}, 30_000);

test('a restarted terminal sends its output even when the previous terminal had the same output length', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-output-restart';
  const terminalId = 'output-restart';
  try {
    await startTerminal(client, 'output-owner', sessionId, terminalId);
    const previous = await entry(client, 'output-owner', sessionId, terminalId);
    await shared(client, 'output-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    await startTerminal(client, 'output-owner', sessionId, terminalId);
    const [current] = await shared(client, 'output-owner', 'list', sessionId, {
      known: { [terminalId]: { generation: previous.generation, outputEnd: previous.outputEnd } },
    });
    expect(current.outputEnd).toBe(previous.outputEnd);
    expect(current.generation).not.toBe(previous.generation);
    expect(current.output).toContain('$ preserved');
  } finally {
    await shared(client, 'output-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('sending an outdated terminal draft fails and preserves the current draft for retry', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-stale-input';
  const terminalId = 'stale-input';
  try {
    await startTerminal(client, 'draft-owner', sessionId, terminalId);
    await shared(client, 'draft-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'new input' });
    expect(await client.failure('shared_terminal', {
      action: 'write_and_clear_draft', clientId: 'draft-owner', hostId: 'local',
      sessionKey: 'local:' + sessionId, sharedTerminalId: terminalId, data: 'old input\n', expectedDraft: 'old input',
    })).toBe('Terminal draft changed; review the input before sending again');
    expect((await entry(client, 'draft-owner', sessionId, terminalId)).inputDraft).toBe('new input');

    await shared(client, 'draft-owner', 'write_and_clear_draft', sessionId, {
      sharedTerminalId: terminalId, data: 'new input\n', expectedDraft: 'new input',
    });
    expect((await entry(client, 'draft-owner', sessionId, terminalId)).inputDraft).toBe('');
  } finally {
    await shared(client, 'draft-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('listing unchanged terminal output still returns the latest input draft', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-output-cache';
  const terminalId = 'output-cache';
  try {
    await startTerminal(client, 'cache-owner', sessionId, terminalId);
    const previous = await entry(client, 'cache-owner', sessionId, terminalId);
    await shared(client, 'cache-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'unsent command' });
    const [current] = await shared(client, 'cache-owner', 'list', sessionId, {
      known: { [terminalId]: { generation: previous.generation, outputEnd: previous.outputEnd } },
    });
    expect(current).toMatchObject({ output: null, inputDraft: 'unsent command', generation: previous.generation, outputEnd: previous.outputEnd });
  } finally {
    await shared(client, 'cache-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('a reconnected owner takes over the listed terminals of its conversation and only it may move them', async () => {
  const old = await daemon.connect();
  const session = await ownedSession(old, 'owner');
  const generation = await startTerminal(old, 'owner', session, 'restored');
  await startTerminal(old, 'owner', 'draft-other', 'unrelated');
  const reconnected = await daemon.connect();
  const listed = await entry(reconnected, 'owner', session, 'restored');
  expect(listed).toMatchObject({ generation, owned: true, exited: false });
  expect(listed.output).toContain('$ preserved');
  await shared(reconnected, 'owner', 'reassign', 'draft-child', { sharedTerminalId: 'restored' });
  expect(await old.failure('shared_terminal', { action: 'reassign', clientId: 'owner', sessionKey: 'local:draft-wrong', hostId: 'local', sharedTerminalId: 'restored' }))
    .toBe('Take ownership of this session before changing its terminals');
  expect(await entry(reconnected, 'owner', session, 'restored')).toBeUndefined();
  expect(await entry(reconnected, 'owner', 'draft-child', 'restored')).toMatchObject({ owned: true, generation });
  expect(await entry(old, 'owner', 'draft-wrong', 'restored')).toBeUndefined();
  // The terminal of the other conversation still belongs to the old connection.
  expect(await entry(old, 'owner', 'draft-other', 'unrelated')).toMatchObject({ owned: true });
  expect(await entry(reconnected, 'owner', 'draft-other', 'unrelated')).toMatchObject({ owned: false });
  await shared(reconnected, 'owner', 'close', 'draft-child', { sharedTerminalId: 'restored' });
  await shared(old, 'owner', 'close', 'draft-other', { sharedTerminalId: 'unrelated' });
  old.close(); reconnected.close();
}, 30_000);

test('listing a conversation another client owns, or a draft of another connection, leaves the terminal with its first connection', async () => {
  const original = await daemon.connect();
  const saved = await ownedSession(original, 'original');
  for (const [sessionId, terminalId] of [[saved, 'saved-terminal'], ['draft-reconnected', 'draft-terminal']] as const) {
    await startTerminal(original, 'original', sessionId, terminalId);
    const another = await daemon.connect();
    expect(await entry(another, 'another', sessionId, terminalId), sessionId).toMatchObject({ owned: false });
    expect(await another.failure('shared_terminal', { action: 'reassign', clientId: 'another', sessionKey: 'local:draft-wrong', hostId: 'local', sharedTerminalId: terminalId }))
      .toBe('Take ownership of this session before changing its terminals');
    expect(await entry(original, 'original', sessionId, terminalId), sessionId).toMatchObject({ owned: true });
    another.close();
    await shared(original, 'original', 'close', sessionId, { sharedTerminalId: terminalId });
  }
  original.close();
}, 30_000);
