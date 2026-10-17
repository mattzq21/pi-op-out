import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fakeProgram, startDaemon, type TestDaemon } from './harness';
import { startHost, type TestHost } from './host-fixture';

function publicSession(home: string, folder = 'host'): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home, cwd: home, folder, content: '' }),
  }));
}

let daemon: TestDaemon;
beforeAll(async () => {
  daemon = await startDaemon();
  const bin = join(daemon.home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = flag => args[args.lastIndexOf(flag) + 1];
const sessionFile = at('--session');
const sessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id;
const state = { sessionFile, sessionId, isStreaming: false, messageCount: 1, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
const send = packet => process.stdout.write(JSON.stringify(packet) + '\\n');
let followUp = [];
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if ((sessionFile.includes('/abort-preparation/') || sessionFile.includes('/abort-gate/')) && request.type === 'piop_request'
      && request.command === 'control' && request.payload.action === 'cancel-preparation') {
    send({ type: 'fixture_waiting', command: 'cancel-preparation' });
    return;
  }
  if (sessionFile.includes('/abort-gate/') && request.type === 'piop_request' && request.command === 'prepare_goal_prompt') {
    send({ type: 'fixture_waiting', command: 'prepare_goal_prompt' });
    return;
  }
  if (request.type === 'piop_request' && request.command === 'queue_prompt') {
    followUp.push(request.payload.message);
    send({ type: 'queue_update', steering: [], followUp: [request.payload.message] });
  }
  if (request.type === 'clear_queue') {
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { steering: [], followUp } });
    followUp = [];
    return;
  }
  const data = request.type === 'get_state' ? state : null;
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data }) + '\\n');
});
`);
}, 60_000);

test('queue updates keep the attachment metadata and item ID but omit image data', async () => {
  const session = publicSession(daemon.home);
  const runtime = await open(session.path, 'queue-client');
  await command(runtime.runtimeId, { type: 'follow_up', message: 'inspect', images: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('private-image').toString('base64') }] });
  const packet = await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId
    && packet.event?.type === 'queue_update' && packet.event.pendingMessages?.some((item: any) => item.message === 'inspect'));
  const item = packet.event.pendingMessages.find((item: any) => item.message === 'inspect');
  expect(item.id).toBeString();
  expect(item.id.length).toBeGreaterThan(0);
  expect(item.behavior).toBe('followUp');
  expect(item.images).toEqual([{ type: 'image', mimeType: 'image/png' }]);
  const state = await command(runtime.runtimeId, { type: 'get_state' });
  expect(state.pendingMessages).toContainEqual(item);
  await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId });
});
afterAll(() => daemon?.stop());

const command = (runtimeId: string, value: any) => daemon.invoke('pi_command', { runtimeId, command: value });
const open = (path: string, clientId: string, runtimeId = randomUUID()) =>
  daemon.invoke('start_pi', { runtimeId, clientId, cwd: daemon.home, sessionPath: path }).then(result => ({ runtimeId, ...result }));

test('a pending message protects its referenced temporary folder from cleanup', async () => {
  const temporary = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const session = publicSession(daemon.home, 'queue-folder-reference');
  const runtime = await open(session.path, 'queue-folder-client');
  try {
    const message = 'Read the files in ' + temporary.cwd;
    await command(runtime.runtimeId, { type: 'follow_up', message });
    const state = await command(runtime.runtimeId, { type: 'get_state' });
    expect(state.pendingMessages).toContainEqual(expect.objectContaining({ message }));

    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toBe(temporary.cwd);
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages)
      .toContainEqual(expect.objectContaining({ message }));
    await command(runtime.runtimeId, { type: 'clear_queue' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([]);
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.failure('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toContain('is unavailable');
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('a second client stays read-only until it takes ownership of the live conversation', async () => {
  const session = publicSession(daemon.home);
  const first = await open(session.path, 'first');
  expect(first.owned).toBe(true);
  const second = await open(session.path, 'second');
  expect(second.owned).toBe(false);
  expect(await daemon.failure('pi_command', { runtimeId: second.runtimeId, command: { type: 'prompt', message: 'blocked' } })).toContain('ownership');
  // A rejected claim leaves the first client's right to send commands intact.
  await command(first.runtimeId, { type: 'prompt', message: 'still owned' });
  expect(await command(second.runtimeId, { type: 'take_ownership' })).toMatchObject({ owned: true });
  expect(await daemon.failure('pi_command', { runtimeId: first.runtimeId, command: { type: 'prompt', message: 'blocked' } })).toContain('ownership');
  await daemon.invoke('stop_pi', { runtimeId: first.runtimeId });
  await daemon.invoke('stop_pi', { runtimeId: second.runtimeId });
});

test('archiving releases ownership so other clients can restore and delete the archive', async () => {
  const session = publicSession(daemon.home);
  const first = await open(session.path, 'archive-first');
  expect(first.owned).toBe(true);
  await daemon.invoke('archive_session', { sessionPath: session.path, hostId: 'local', clientId: 'archive-first', terminalIds: [] });
  const report = await daemon.invoke('storage_report');
  const archive = report.hosts[0].archives.find((item: any) => item.id === session.id);
  expect(archive).toBeDefined();
  await daemon.invoke('restore_archived_session', { sessionPath: archive.path, hostId: 'local', clientId: 'archive-second' });
  expect((await daemon.invoke('list_sessions')).some((item: any) => item.id === session.id)).toBe(true);
  await daemon.invoke('archive_session', { sessionPath: session.path, hostId: 'local', clientId: 'archive-second', terminalIds: [] });
  await daemon.invoke('delete_archived_session', { sessionPath: archive.path, hostId: 'local', clientId: 'archive-third' });
  expect((await daemon.invoke('storage_report')).hosts[0].archives.some((item: any) => item.id === session.id)).toBe(false);
});

test('only the last released client can reassign its terminal, until another client owns the conversation', async () => {
  const session = publicSession(daemon.home);
  const terminalId = randomUUID();
  const shared = (action: string, clientId: string, extra: any = {}) => daemon.invoke('shared_terminal', {
    action, clientId, sharedTerminalId: terminalId, sessionKey: 'local:' + session.id, ...extra,
  });
  const first = await open(session.path, 'released-first');
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === first.runtimeId
    && packet.event?.type === 'settings_pending' && packet.event.pending === false);
  await shared('start', 'released-first', { cwd: daemon.home, cols: 80, rows: 24 });
  await daemon.invoke('stop_pi', { runtimeId: first.runtimeId });
  await expect(shared('write', 'released-first', { data: '' })).rejects.toThrow('Take ownership');
  await expect(shared('reassign', 'released-second', { sessionKey: 'local:draft-other' })).rejects.toThrow('Take ownership');
  await shared('reassign', 'released-first', { sessionKey: 'local:draft-return' });
  const reopened = await open(session.path, 'released-first');
  await shared('reassign', 'released-first');
  await daemon.invoke('stop_pi', { runtimeId: reopened.runtimeId });
  const second = await open(session.path, 'released-second');
  await expect(shared('reassign', 'released-first', { sessionKey: 'local:draft-stale' })).rejects.toThrow('Take ownership');
  // Listing transfers the terminal to the client that now owns its conversation.
  expect(await shared('list', 'released-second')).toEqual([expect.objectContaining({ id: terminalId, owned: true })]);
  await daemon.invoke('stop_pi', { runtimeId: second.runtimeId });
  await expect(shared('reassign', '', { sessionKey: 'local:draft-empty' })).rejects.toThrow('Take ownership');
  await expect(shared('reassign', 'released-first', { sessionKey: 'local:draft-stale' })).rejects.toThrow('Take ownership');
  await shared('reassign', 'released-second', { sessionKey: 'local:draft-last' });
  await shared('close', 'released-second');
});



test('abort stops an external Pi that never answers preparation cancellation', async () => {
  const session = publicSession(daemon.home, 'abort-preparation');
  const runtime = await open(session.path, 'abort-client');
  const started = Date.now();
  const abort = command(runtime.runtimeId, { type: 'abort' });
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'fixture_waiting');
  await abort;
  expect(Date.now() - started).toBeLessThan(6000);
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'disconnected', 1000);
  expect(await daemon.failure('pi_command', { runtimeId: runtime.runtimeId, command: { type: 'get_state' } })).toContain('not running');
}, 15_000);

async function attachHostSession(host: TestHost, path: string, sessionId: string, clientId: string) {
  const runtimeId = randomUUID();
  const result = await host.request({ type: 'attach', runtimeId, sessionKey: sessionId, clientId,
    cwd: host.home, timeout: 10_000,
    spec: { program: join(daemon.home, '.local/bin/node'), args: ['--session', path], env: {}, cwd: host.home },
  });
  expect(result).toMatchObject({ owned: true });
  return runtimeId;
}

test('a replacement host rejects the previous host’s released ownership until the client claims again', async () => {
  const first = await startHost();
  let second: TestHost | undefined;
  try {
    const session = publicSession(first.home);
    const clientId = 'replacement-client';
    const owner = { type: 'conversation_owner', sessionId: session.id, clientId, allowReleased: true };
    const runtimeId = await attachHostSession(first, session.path, session.id, clientId);
    await first.request({ type: 'detach', runtimeId });
    expect(await first.request(owner)).toBe(true);
    expect(await first.request({ ...owner, allowReleased: false })).toBe(false);
    await first.stop();
    second = await startHost({ home: first.home });
    expect(await second.request(owner)).toBe(false);
    const replacement = await attachHostSession(second, session.path, session.id, clientId);
    expect(await second.request({ ...owner, allowReleased: false })).toBe(true);
    await second.request({ type: 'detach', runtimeId: replacement });
    expect(await second.request(owner)).toBe(true);
  } finally { await second?.stop(); await first.stop(); }
});



test('abort stops Pi while both a goal preparation and its cancellation are stuck', async () => {
  const session = publicSession(daemon.home, 'abort-gate');
  const runtime = await open(session.path, 'abort-gate-client');
  const preparation = command(runtime.runtimeId, { type: 'follow_up', message: '/goal inspect the project' })
    .then(() => 'answered', (error: Error) => error.message);
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId
    && packet.event?.type === 'fixture_waiting' && packet.event.command === 'prepare_goal_prompt');
  const started = Date.now();
  const abort = command(runtime.runtimeId, { type: 'abort' });
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId
    && packet.event?.type === 'fixture_waiting' && packet.event.command === 'cancel-preparation');
  await abort;
  expect(Date.now() - started).toBeLessThan(6000);
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'disconnected', 1000);
  expect(await preparation).not.toBe('answered');
  expect(await daemon.failure('pi_command', { runtimeId: runtime.runtimeId, command: { type: 'get_state' } })).toContain('not running');
}, 15_000);
