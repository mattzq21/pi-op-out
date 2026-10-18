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

test('closing an unused terminal stops it, but preserves terminals with input even after the draft is erased', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-unused-shell';
  const ids = ['unused-shell', 'typed-shell', 'written-shell'];
  try {
    for (const id of ids) await startTerminal(client, 'unused-owner', sessionId, id);
    await shared(client, 'unused-owner', 'resize', sessionId, { sharedTerminalId: ids[0], cols: 100, rows: 30 });
    await shared(client, 'unused-owner', 'reply', sessionId, { sharedTerminalId: ids[0], data: '\u001b[1;1R' });
    await shared(client, 'unused-owner', 'draft', sessionId, { sharedTerminalId: ids[1], data: 'hello' });
    await shared(client, 'unused-owner', 'draft', sessionId, { sharedTerminalId: ids[1], data: '' });
    await shared(client, 'unused-owner', 'write', sessionId, { sharedTerminalId: ids[2], data: 'x' });
    for (const id of ids) await shared(client, 'unused-owner', 'close_unused', sessionId, { sharedTerminalId: id });
    expect(await entry(client, 'unused-owner', sessionId, ids[0]!)).toBeUndefined();
    expect(await client.failure('write_terminal', { terminalId: ids[0], data: 'x' })).toBe('Terminal is not running');
    for (const id of ids.slice(1)) expect(await entry(client, 'unused-owner', sessionId, id)).toMatchObject({ exited: false });
  } finally {
    for (const id of ids) await shared(client, 'unused-owner', 'close', sessionId, { sharedTerminalId: id });
    client.close();
  }
});

test('resizing a shared terminal changes the dimensions seen by its shell', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-shell-size';
  const terminalId = 'shell-size';
  const directory = temporaryDirectory('piop-shell-size-');
  writeFileSync(join(directory, '.terminal-script'), "IFS= read -r line\nprintf 'SIZE:'\nstty size\n");
  try {
    await shared(client, 'size-reader', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(client, 'size-reader', 'resize', sessionId, { sharedTerminalId: terminalId, cols: 113, rows: 37 });
    await shared(client, 'size-reader', 'write', sessionId, { sharedTerminalId: terminalId, data: '\n' });
    await client.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    expect((await entry(client, 'size-reader', sessionId, terminalId)).output).toContain('SIZE:37 113');
  } finally {
    await shared(client, 'size-reader', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('sending reviewed terminal text delivers it once and clears its matching draft', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-reviewed-input';
  const terminalId = 'reviewed-input';
  const directory = temporaryDirectory('piop-reviewed-input-');
  writeFileSync(join(directory, '.terminal-script'), "IFS= read -r line\nprintf 'RECEIVED:<%s>\\n' \"$line\"\n");
  try {
    await shared(client, 'reviewed-owner', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(client, 'reviewed-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'reviewed text' });
    await shared(client, 'reviewed-owner', 'write_and_clear_draft', sessionId, {
      sharedTerminalId: terminalId, data: 'reviewed text\n', expectedDraft: 'reviewed text',
    });
    await client.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    const result = await entry(client, 'reviewed-owner', sessionId, terminalId);
    expect(result.output).toContain('RECEIVED:<reviewed text>');
    expect(result.inputDraft).toBe('');
  } finally {
    await shared(client, 'reviewed-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

for (const action of ['write', 'reply']) test(`${action} sends only the supplied text and keeps the saved draft`, async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-direct-shell-input';
  const terminalId = 'direct-shell-input';
  const directory = temporaryDirectory('piop-direct-input-');
  writeFileSync(join(directory, '.terminal-script'), "IFS= read -r line\nprintf 'RECEIVED:<%s>\\n' \"$line\"\n");
  try {
    await shared(client, 'direct-owner', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(client, 'direct-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Keep for later' });
    await shared(client, 'direct-owner', action, sessionId, { sharedTerminalId: terminalId, data: 'direct text\n' });
    await client.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    const result = await entry(client, 'direct-owner', sessionId, terminalId);
    expect(result.output).toContain('RECEIVED:<direct text>');
    expect(result.inputDraft).toBe('Keep for later');
  } finally {
    await shared(client, 'direct-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('sending with a draft delivers the saved text before the new input to the shell', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-shell-input';
  const terminalId = 'shell-input';
  const directory = temporaryDirectory('piop-terminal-input-');
  writeFileSync(join(directory, '.terminal-script'), "IFS= read -r line\nprintf 'RECEIVED:<%s>\\n' \"$line\"\n");
  try {
    await shared(client, 'shell-owner', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(client, 'shell-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'saved ' });
    await shared(client, 'shell-owner', 'write_with_draft', sessionId, { sharedTerminalId: terminalId, data: 'text\n' });
    await client.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    const result = await entry(client, 'shell-owner', sessionId, terminalId);
    expect(result.output).toContain('RECEIVED:<saved text>');
    expect(result.inputDraft).toBe('');
  } finally {
    await shared(client, 'shell-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('discarding one terminal view keeps another view on the same connection', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-two-views';
  const request = (view: string, action: string, args: Record<string, unknown> = {}) =>
    shared(client, 'view-owner', action, sessionId, { terminalConnectionId: view, ...args });
  try {
    for (const view of ['main', 'split']) {
      await request(view, 'start', { sharedTerminalId: 'view-' + view, cwd, cols: 80, rows: 24 });
      await request(view, 'draft', { sharedTerminalId: 'view-' + view, data: view + ' command' });
    }
    await request('main', 'discard_drafts');
    const remaining = await request('split', 'list');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: 'view-split', owned: true, exited: false, inputDraft: 'split command' });
    await request('split', 'draft', { sharedTerminalId: 'view-split', data: 'Still editable' });
    expect((await request('split', 'list'))[0].inputDraft).toBe('Still editable');
  } finally {
    await request('main', 'close', { sharedTerminalId: 'view-main' });
    await request('split', 'close', { sharedTerminalId: 'view-split' });
    client.close();
  }
}, 30_000);

test('connected clients receive terminal draft edits and clearing after send', async () => {
  const owner = await daemon.connect();
  const observer = await daemon.connect();
  const sessionId = 'draft-notifications';
  const terminalId = 'draft-notifications-terminal';
  try {
    const generation = await startTerminal(owner, 'notification-owner', sessionId, terminalId);
    await shared(owner, 'notification-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Unsent text' });
    const edited = await observer.waitEvent('pi://event', event =>
      event.type === 'terminal_draft' && event.terminalId === terminalId && event.data === 'Unsent text');
    expect(edited).toMatchObject({ sessionId, hostId: 'local', generation, data: 'Unsent text' });

    await shared(owner, 'notification-owner', 'write_and_clear_draft', sessionId, {
      sharedTerminalId: terminalId, data: 'Unsent text\n', expectedDraft: 'Unsent text',
    });
    const cleared = await observer.waitEvent('pi://event', event =>
      event.type === 'terminal_draft' && event.terminalId === terminalId && event.data === '');
    expect(cleared).toMatchObject({ sessionId, hostId: 'local', generation, data: '' });
  } finally {
    await shared(owner, 'notification-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    owner.close(); observer.close();
  }
}, 30_000);

test('starting another chat with an existing terminal ID preserves the original terminal', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-original-terminal';
  const terminalId = 'duplicate-terminal-id';
  try {
    const generation = await startTerminal(client, 'unique-owner', sessionId, terminalId);
    await shared(client, 'unique-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Original draft' });
    expect(await client.failure('shared_terminal', {
      action: 'start', clientId: 'unique-owner', hostId: 'local', sessionKey: 'local:draft-other-terminal',
      sharedTerminalId: terminalId, cwd, cols: 80, rows: 24,
    })).toBe('Terminal belongs to another session');
    expect(await entry(client, 'unique-owner', sessionId, terminalId))
      .toMatchObject({ generation, owned: true, exited: false, inputDraft: 'Original draft', output: expect.stringContaining('$ preserved') });
    expect(await shared(client, 'unique-owner', 'list', 'draft-other-terminal')).toEqual([]);
  } finally {
    await shared(client, 'unique-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('an exited terminal keeps its final output and preserves a draft when sending fails', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-exited-output';
  const terminalId = 'exited-output';
  const directory = temporaryDirectory('piop-terminal-exit-');
  writeFileSync(join(directory, '.terminal-script'), "printf 'Finished successfully\\n'\n");
  try {
    await shared(client, 'exit-owner', 'start', sessionId, {
      sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24,
    });
    await client.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    expect(await entry(client, 'exit-owner', sessionId, terminalId))
      .toMatchObject({ exited: true, output: expect.stringContaining('Finished successfully') });
    await shared(client, 'exit-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Keep for next shell' });
    expect(await client.failure('shared_terminal', {
      action: 'write_and_clear_draft', clientId: 'exit-owner', hostId: 'local',
      sessionKey: 'local:' + sessionId, sharedTerminalId: terminalId,
      data: 'Keep for next shell\n', expectedDraft: 'Keep for next shell',
    })).toBe('Terminal is not running');
    expect((await entry(client, 'exit-owner', sessionId, terminalId)).inputDraft).toBe('Keep for next shell');
  } finally {
    await shared(client, 'exit-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

test('a failed restart of an exited terminal keeps its output and draft, and a valid retry accepts input', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-failed-restart';
  const terminalId = 'failed-restart';
  const directory = temporaryDirectory('piop-failed-restart-');
  writeFileSync(join(directory, '.terminal-script'),
    "if [ -f ./.first-run ]; then IFS= read -r line; printf 'RECEIVED:<%s>\\n' \"$line\"; else : > ./.first-run; printf 'First run finished\\n'; fi\n");
  const restart = (args: Record<string, unknown>) => client.failure('shared_terminal', {
    action: 'start', clientId: 'restart-owner', hostId: 'local', sessionKey: 'local:' + sessionId, sharedTerminalId: terminalId, ...args,
  });
  try {
    await shared(client, 'restart-owner', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    const first = await client.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    await shared(client, 'restart-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Keep for next shell' });

    const missing = join(directory, 'missing');
    expect(await restart({ cwd: missing, cols: 80, rows: 24 })).toBe('Terminal working directory does not exist: ' + missing);
    expect(await restart({ cwd: directory, cols: 70000, rows: 24 })).toBe('Invalid cols');
    expect(await entry(client, 'restart-owner', sessionId, terminalId)).toMatchObject({
      generation: first.generation, exited: true, inputDraft: 'Keep for next shell', output: expect.stringContaining('First run finished'),
    });

    await shared(client, 'restart-owner', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(client, 'restart-owner', 'write', sessionId, { sharedTerminalId: terminalId, data: 'after restart\n' });
    await client.waitEvent('pi://event', event =>
      event.type === 'terminal_exit' && event.terminalId === terminalId && event.generation !== first.generation);
    expect((await entry(client, 'restart-owner', sessionId, terminalId)).output).toContain('RECEIVED:<after restart>');
  } finally {
    await shared(client, 'restart-owner', 'close', sessionId, { sharedTerminalId: terminalId });
    client.close();
  }
}, 30_000);

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

test('after another client takes the chat, the connection that opened its terminal cannot send its draft', async () => {
  const former = await daemon.connect();
  const taker = await daemon.connect();
  const chat = await former.invoke('create_temporary_chat', { hostId: 'local' });
  const terminalId = 'taken-over';
  const directory = temporaryDirectory('piop-taken-over-');
  writeFileSync(join(directory, '.terminal-script'), "IFS= read -r line\nprintf 'RECEIVED:<%s>\\n' \"$line\"\n");
  const start = (client: Client, runtimeId: string, clientId: string) =>
    client.invoke('start_pi', { runtimeId, clientId, cwd: chat.cwd, sessionId: chat.sessionId });
  try {
    expect(await start(former, 'taken-over-former', 'former-owner')).toMatchObject({ owned: true });
    await shared(former, 'former-owner', 'start', chat.sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(former, 'former-owner', 'draft', chat.sessionId, { sharedTerminalId: terminalId, data: 'Former owner command' });
    expect(await start(taker, 'taken-over-taker', 'new-owner')).toMatchObject({ owned: false });
    expect(await taker.invoke('pi_command', { runtimeId: 'taken-over-taker', command: { type: 'take_ownership' } })).toMatchObject({ owned: true });

    expect(await former.failure('shared_terminal', {
      action: 'write_and_clear_draft', clientId: 'former-owner', hostId: 'local', sessionKey: 'local:' + chat.sessionId,
      sharedTerminalId: terminalId, data: 'Former owner command\n', expectedDraft: 'Former owner command',
    })).toBe('Take ownership of this session before changing its terminals');
    expect(await entry(taker, 'new-owner', chat.sessionId, terminalId))
      .toMatchObject({ owned: true, exited: false, inputDraft: 'Former owner command' });

    await shared(taker, 'new-owner', 'draft', chat.sessionId, { sharedTerminalId: terminalId, data: 'Reviewed by new owner' });
    await shared(taker, 'new-owner', 'write_and_clear_draft', chat.sessionId, {
      sharedTerminalId: terminalId, data: 'Reviewed by new owner\n', expectedDraft: 'Reviewed by new owner',
    });
    await taker.waitEvent('pi://event', event => event.type === 'terminal_exit' && event.terminalId === terminalId);
    const result = await entry(taker, 'new-owner', chat.sessionId, terminalId);
    expect(result.output).toContain('RECEIVED:<Reviewed by new owner>');
    expect(result.output).not.toContain('Former owner command');
    expect(result.inputDraft).toBe('');
  } finally {
    await shared(taker, 'new-owner', 'close', chat.sessionId, { sharedTerminalId: terminalId });
    await taker.invoke('stop_pi', { runtimeId: 'taken-over-taker' });
    await former.invoke('stop_pi', { runtimeId: 'taken-over-former' });
    former.close(); taker.close();
  }
}, 60_000);

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

test('sending oversized Unicode terminal input is rejected, keeps the draft, and a corrected send reaches the shell once', async () => {
  const client = await daemon.connect();
  const sessionId = 'draft-input-size-limit';
  const terminalId = 'input-size-limit';
  const directory = temporaryDirectory('piop-input-size-limit-');
  writeFileSync(join(directory, '.terminal-script'), "while IFS= read -r line; do printf 'RECEIVED:<%s>\\n' \"$line\"; done\n");
  const from = client.events.length;
  const output = () => client.events.slice(from)
    .filter(event => event.event === 'pi://event' && event.payload?.type === 'terminal_output' && event.payload.terminalId === terminalId)
    .map(event => event.payload.data).join('');
  try {
    await shared(client, 'input-size-owner', 'start', sessionId, { sharedTerminalId: terminalId, cwd: directory, cols: 80, rows: 24 });
    await shared(client, 'input-size-owner', 'draft', sessionId, { sharedTerminalId: terminalId, data: 'Keep this command' });
    // 262145 ducks are 524290 UTF-16 characters but 1048580 bytes.
    expect(await client.failure('shared_terminal', {
      action: 'write_and_clear_draft', clientId: 'input-size-owner', hostId: 'local', sessionKey: 'local:' + sessionId,
      sharedTerminalId: terminalId, data: '🦆'.repeat(262145) + '\n', expectedDraft: 'Keep this command',
    })).toBe('Terminal input exceeds 1 MiB');
    expect((await entry(client, 'input-size-owner', sessionId, terminalId)).inputDraft).toBe('Keep this command');

    await shared(client, 'input-size-owner', 'write_and_clear_draft', sessionId, {
      sharedTerminalId: terminalId, data: 'Keep this command\n', expectedDraft: 'Keep this command',
    });
    await client.waitEvent('pi://event', () => output().includes('RECEIVED:<Keep this command>'));
    const result = await entry(client, 'input-size-owner', sessionId, terminalId);
    expect(result.output.match(/RECEIVED:<[^>]*>/g)).toEqual(['RECEIVED:<Keep this command>']);
    expect(result.output).not.toContain('🦆');
    expect(result.inputDraft).toBe('');
  } finally {
    await shared(client, 'input-size-owner', 'close', sessionId, { sharedTerminalId: terminalId });
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
  await shared(reconnected, 'owner', 'draft', session, { sharedTerminalId: 'restored', data: 'Continue after moving' });
  await shared(reconnected, 'owner', 'reassign', 'draft-child', { sharedTerminalId: 'restored' });
  expect(await old.failure('shared_terminal', { action: 'reassign', clientId: 'owner', sessionKey: 'local:draft-wrong', hostId: 'local', sharedTerminalId: 'restored' }))
    .toBe('Take ownership of this session before changing its terminals');
  expect(await entry(reconnected, 'owner', session, 'restored')).toBeUndefined();
  expect(await entry(reconnected, 'owner', 'draft-child', 'restored')).toMatchObject({
    owned: true, generation, exited: false, inputDraft: 'Continue after moving', output: expect.stringContaining('$ preserved'),
  });
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

test('a saved chat terminal outlives its closed connection and returns to the same client after it takes the chat again', async () => {
  // A separate daemon, so that this test alone holds its 8 connection slots.
  const isolated = await startDaemon();
  const fillers: Client[] = [];
  let reconnected: Client | undefined;
  const full = 'Daemon rejected the connection: Too many connections';
  const connectUnlessFull = () => isolated.connect().catch((error: Error) => { if (error.message === full) return undefined; throw error; });
  try {
    writeFileSync(join(isolated.home, '.bashrc'), '[ -f ./.terminal-script ] && exec sh ./.terminal-script\n');
    const original = await isolated.connect();
    const chat = await original.invoke('create_temporary_chat', { hostId: 'local' });
    const start = (client: Client, runtimeId: string) =>
      client.invoke('start_pi', { runtimeId, clientId: 'returning-owner', cwd: chat.cwd, sessionId: chat.sessionId });
    expect(await start(original, 'before-disconnect')).toMatchObject({ owned: true });
    const generation = await startTerminal(original, 'returning-owner', chat.sessionId, 'outlives-connection');
    await shared(original, 'returning-owner', 'draft', chat.sessionId, { sharedTerminalId: 'outlives-connection', data: 'Unsent after disconnect' });

    // The daemon frees a connection slot only after it has cleaned up that connection, and it sends no event for it.
    for (let attempt = 0; ; attempt++) {
      if (attempt === 10) throw new Error('The daemon accepted 10 more connections without becoming full');
      const filler = await connectUnlessFull();
      if (!filler) break;
      fillers.push(filler);
    }
    original.close();
    for (const deadline = Date.now() + 15_000; !reconnected && Date.now() < deadline;) {
      reconnected = await connectUnlessFull();
      if (!reconnected) await Bun.sleep(50);
    }
    if (!reconnected) throw new Error('No connection slot was freed after the original connection closed');

    expect(await entry(reconnected, 'returning-owner', chat.sessionId, 'outlives-connection')).toMatchObject({
      generation, owned: false, exited: false, inputDraft: 'Unsent after disconnect', output: expect.stringContaining('$ preserved'),
    });
    expect(await start(reconnected, 'after-disconnect')).toMatchObject({ owned: true });
    expect(await entry(reconnected, 'returning-owner', chat.sessionId, 'outlives-connection')).toMatchObject({
      generation, owned: true, exited: false, inputDraft: 'Unsent after disconnect',
    });
    await shared(reconnected, 'returning-owner', 'draft', chat.sessionId, { sharedTerminalId: 'outlives-connection', data: 'Edited after taking over' });
    expect((await entry(reconnected, 'returning-owner', chat.sessionId, 'outlives-connection')).inputDraft).toBe('Edited after taking over');
  } finally {
    reconnected?.close();
    for (const filler of fillers) filler.close();
    await isolated.stop();
  }
}, 60_000);
