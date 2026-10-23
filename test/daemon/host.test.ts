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
    input: JSON.stringify({ home, cwd: home, folder, content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Hello', timestamp: 1 } }) + '\n' }),
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
let rejectClear = sessionFile.includes('/reject-clear-once/');
let rejectRedelivery = sessionFile.includes('/reject-redelivery-once/');
const rejectSecondRedelivery = sessionFile.includes('/reject-second-redelivery/');
const rejectResendAndRetry = sessionFile.includes('/reject-resend-and-retry/');
const rejections = ['Pi rejected the resend', 'Pi rejected the retry'];
let redeliveries = 0;
let cleared = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if ((sessionFile.includes('/abort-preparation/') || sessionFile.includes('/abort-gate/')) && request.type === 'piop_request'
      && request.command === 'control' && request.payload.action === 'stop') {
    send({ type: 'fixture_waiting', command: 'stop' });
    return;
  }
  if (sessionFile.includes('/abort-gate/') && request.type === 'piop_request' && request.command === 'prepare_goal_prompt') {
    send({ type: 'fixture_waiting', command: 'prepare_goal_prompt' });
    return;
  }
  if (request.type === 'piop_request' && request.command === 'queue_prompt') {
    if (rejectRedelivery && cleared) {
      rejectRedelivery = false;
      send({ type: 'response', id: request.id, command: request.type, success: false, error: 'Pi is temporarily busy' });
      return;
    }
    if (rejectSecondRedelivery && cleared && ++redeliveries === 2) {
      send({ type: 'response', id: request.id, command: request.type, success: false, error: 'Pi rejected the second resend' });
      return;
    }
    if (rejectResendAndRetry && cleared && rejections.length) {
      send({ type: 'response', id: request.id, command: request.type, success: false, error: rejections.shift() });
      return;
    }
    followUp.push(request.payload.message);
    if (rejectResendAndRetry) send({ type: 'fixture_prompt_received', queueId: request.payload.queueId, images: request.payload.images });
    send({ type: 'queue_update', steering: [], followUp });
  }
  if (request.type === 'clear_queue') {
    if (rejectClear) {
      rejectClear = false;
      send({ type: 'response', id: request.id, command: request.type, success: false, error: 'Queue is temporarily unavailable' });
      return;
    }
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { steering: [], followUp } });
    followUp = [];
    cleared = true;
    return;
  }
  const data = request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: sessionFile ? fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)) : [] } : null;
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

test('a failed queue clear preserves pending messages and allows retry', async () => {
  const session = publicSession(daemon.home, 'reject-clear-once');
  const runtime = await open(session.path, 'clear-retry-client');
  try {
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Keep until clearing succeeds' });
    const before = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(before).toHaveLength(1);
    expect(await daemon.failure('pi_command', { runtimeId: runtime.runtimeId, command: { type: 'clear_queue' } }))
      .toContain('Queue is temporarily unavailable');
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(before);
    await command(runtime.runtimeId, { type: 'clear_queue' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([]);
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('moving a queued message changes order without replacing message identities', async () => {
  const session = publicSession(daemon.home, 'reorder-queued-messages');
  const runtime = await open(session.path, 'reorder-queue-client');
  try {
    for (const message of ['First task', 'Second task', 'Third task']) {
      await command(runtime.runtimeId, { type: 'follow_up', message });
    }
    const before = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(before.map((item: any) => item.message)).toEqual(['First task', 'Second task', 'Third task']);
    await command(runtime.runtimeId, { type: 'change_pending', id: before[2].id, action: 'moveUp' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages)
      .toEqual([before[0], before[2], before[1]]);
    await command(runtime.runtimeId, { type: 'change_pending', id: before[2].id, action: 'moveDown' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(before);
    await command(runtime.runtimeId, {
      type: 'change_pending', id: before[0].id, action: { type: 'move', targetId: before[2].id, edge: 'after' },
    });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages)
      .toEqual([before[1], before[2], before[0]]);
    await command(runtime.runtimeId, {
      type: 'change_pending', id: before[0].id, action: { type: 'move', targetId: before[1].id, edge: 'before' },
    });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(before);
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('a reorder that Pi rejects keeps both messages for retry, and retrying sends them in the chosen order', async () => {
  const session = publicSession(daemon.home, 'reject-redelivery-once');
  const runtime = await open(session.path, 'reject-redelivery-client');
  try {
    await command(runtime.runtimeId, { type: 'follow_up', message: 'First task' });
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Second task' });
    const [first, second] = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(await daemon.failure('pi_command', {
      runtimeId: runtime.runtimeId, command: { type: 'change_pending', id: second.id, action: 'moveUp' },
    })).toContain('Pi is temporarily busy');
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([
      { ...second, retry: true }, { ...first, retry: true },
    ]);
    await command(runtime.runtimeId, { type: 'change_pending', id: second.id, action: 'followUp' });
    await command(runtime.runtimeId, { type: 'change_pending', id: first.id, action: 'followUp' });
    const state = await command(runtime.runtimeId, { type: 'get_state' });
    expect(state.pendingMessages.map(({ id, message, behavior, retry }: any) => ({ id, message, behavior, retry: retry === true })))
      .toEqual([{ ...second, retry: false }, { ...first, retry: false }]);
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'queue_update'
      && JSON.stringify(packet.event.followUp) === JSON.stringify(['Second task', 'First task']));
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('a failed resend keeps a removed message gone and preserves the remaining messages for retry', async () => {
  const session = publicSession(daemon.home, 'reject-redelivery-once');
  const runtime = await open(session.path, 'reject-removal-resend-client');
  try {
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Remove this' });
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Keep the image', images: [
      { type: 'image', mimeType: 'image/png', data: Buffer.from('survivor-image').toString('base64') },
    ] });
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Keep the text' });
    const [removed, image, plain] = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(image.images).toEqual([{ type: 'image', mimeType: 'image/png' }]);
    expect(await daemon.failure('pi_command', {
      runtimeId: runtime.runtimeId, command: { type: 'change_pending', id: removed.id, action: 'remove' },
    })).toContain('Pi is temporarily busy');
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([
      { ...image, retry: true }, { ...plain, retry: true },
    ]);
    await command(runtime.runtimeId, { type: 'change_pending', id: image.id, action: 'followUp' });
    await command(runtime.runtimeId, { type: 'change_pending', id: plain.id, action: 'followUp' });
    const state = await command(runtime.runtimeId, { type: 'get_state' });
    expect(state.pendingMessages.map(({ id, message, images, retry }: any) => ({ id, message, images, retry: retry === true })))
      .toEqual([
        { id: image.id, message: 'Keep the image', images: [{ type: 'image', mimeType: 'image/png' }], retry: false },
        { id: plain.id, message: 'Keep the text', images: undefined, retry: false },
      ]);
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'queue_update'
      && JSON.stringify(packet.event.followUp) === JSON.stringify(['Keep the image', 'Keep the text']));
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('when a reorder resend fails partway, only the failed and unsent messages need retry and nothing is sent twice', async () => {
  const session = publicSession(daemon.home, 'reject-second-redelivery');
  const runtime = await open(session.path, 'reject-second-redelivery-client');
  try {
    for (const message of ['First task', 'Second task', 'Third task']) {
      await command(runtime.runtimeId, { type: 'follow_up', message });
    }
    const [first, second, third] = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    // Moving the first message to the end resends Second (accepted), Third (rejected), then First (never sent).
    expect(await daemon.failure('pi_command', { runtimeId: runtime.runtimeId, command: {
      type: 'change_pending', id: first.id, action: { type: 'move', targetId: third.id, edge: 'after' },
    } })).toContain('Pi rejected the second resend');
    const failed = await command(runtime.runtimeId, { type: 'get_state' });
    expect(failed.pendingMessages).toEqual([second, { ...third, retry: true }, { ...first, retry: true }]);
    expect(failed.pendingMessages[0].retry).not.toBe(true);
    await command(runtime.runtimeId, { type: 'change_pending', id: third.id, action: 'followUp' });
    await command(runtime.runtimeId, { type: 'change_pending', id: first.id, action: 'followUp' });
    const state = await command(runtime.runtimeId, { type: 'get_state' });
    expect(state.pendingMessages.map(({ id, message, retry }: any) => ({ id, message, retry: retry === true }))).toEqual([
      { id: second.id, message: 'Second task', retry: false },
      { id: third.id, message: 'Third task', retry: false },
      { id: first.id, message: 'First task', retry: false },
    ]);
    // The order differs from the setup queue, so no setup event can match.
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'queue_update'
      && JSON.stringify(packet.event.followUp) === JSON.stringify(['Second task', 'Third task', 'First task']));
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('after a reorder resend fails partway, removing one retry message keeps the sent message and the other retry message', async () => {
  const session = publicSession(daemon.home, 'reject-second-redelivery');
  const runtime = await open(session.path, 'remove-retry-client');
  try {
    for (const message of ['First task', 'Second task', 'Third task']) {
      await command(runtime.runtimeId, { type: 'follow_up', message });
    }
    const [first, second, third] = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    // Moving the first message to the end resends Second (accepted), Third (rejected), then First (never sent).
    expect(await daemon.failure('pi_command', { runtimeId: runtime.runtimeId, command: {
      type: 'change_pending', id: first.id, action: { type: 'move', targetId: third.id, edge: 'after' },
    } })).toContain('Pi rejected the second resend');
    await command(runtime.runtimeId, { type: 'change_pending', id: third.id, action: 'remove' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([second, { ...first, retry: true }]);
    await command(runtime.runtimeId, { type: 'change_pending', id: first.id, action: 'followUp' });
    const state = await command(runtime.runtimeId, { type: 'get_state' });
    expect(state.pendingMessages.map(({ id, message, retry }: any) => ({ id, message, retry: retry === true }))).toEqual([
      { id: second.id, message: 'Second task', retry: false },
      { id: first.id, message: 'First task', retry: false },
    ]);
    // The order differs from the setup queue, so no setup event can match.
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'queue_update'
      && JSON.stringify(packet.event.followUp) === JSON.stringify(['Second task', 'First task']));
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('a retry that Pi rejects keeps the same pending message for another retry, which then sends it once', async () => {
  const session = publicSession(daemon.home, 'reject-resend-and-retry');
  const runtime = await open(session.path, 'reject-retry-client');
  try {
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Remove this' });
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Keep the image', images: [
      { type: 'image', mimeType: 'image/png', data: Buffer.from('retried-image').toString('base64') },
    ] });
    const [removed, image] = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(await daemon.failure('pi_command', {
      runtimeId: runtime.runtimeId, command: { type: 'change_pending', id: removed.id, action: 'remove' },
    })).toContain('Pi rejected the resend');
    const waiting = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(waiting).toEqual([{ ...image, retry: true }]);
    expect(waiting[0].images).toEqual([{ type: 'image', mimeType: 'image/png' }]);
    expect(await daemon.failure('pi_command', {
      runtimeId: runtime.runtimeId, command: { type: 'change_pending', id: image.id, action: 'followUp' },
    })).toContain('Pi rejected the retry');
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(waiting);
    // Only events after this point can show the successful retry.
    const boundary = daemon.events.length;
    await command(runtime.runtimeId, { type: 'change_pending', id: image.id, action: 'followUp' });
    await daemon.waitEvent('pi://event', packet => daemon.events.slice(boundary).some(event => event.payload === packet)
      && packet.runtimeId === runtime.runtimeId && packet.event?.type === 'queue_update'
      && JSON.stringify(packet.event.followUp) === JSON.stringify(['Keep the image']));
    const received = await daemon.waitEvent('pi://event', packet => daemon.events.slice(boundary).some(event => event.payload === packet)
      && packet.runtimeId === runtime.runtimeId && packet.event?.type === 'fixture_prompt_received');
    expect(received.event.queueId).toBe(image.id);
    expect(received.event.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'cmV0cmllZC1pbWFnZQ==' }]);
    const state = await command(runtime.runtimeId, { type: 'get_state' });
    expect(state.pendingMessages.map(({ id, message, images, retry }: any) => ({ id, message, images, retry: retry === true })))
      .toEqual([{ id: image.id, message: 'Keep the image', images: [{ type: 'image', mimeType: 'image/png' }], retry: false }]);
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('removing one queued message preserves the other message identity and attachment', async () => {
  const session = publicSession(daemon.home, 'remove-queued-message');
  const runtime = await open(session.path, 'remove-queue-client');
  try {
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Remove this' });
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Keep the image', images: [
      { type: 'image', mimeType: 'image/png', data: Buffer.from('queued-image').toString('base64') },
    ] });
    const before = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(before).toHaveLength(2);
    const kept = before.find((item: any) => item.message === 'Keep the image');
    expect(kept.images).toEqual([{ type: 'image', mimeType: 'image/png' }]);
    const oldId = before.find((item: any) => item.message === 'Remove this').id;
    await command(runtime.runtimeId, { type: 'change_pending', id: oldId, action: 'remove' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([kept]);

    await command(runtime.runtimeId, { type: 'follow_up', message: 'Remove this' });
    const withReplacement = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(withReplacement).toHaveLength(2);
    const newId = withReplacement[1].id;
    expect(newId).toBeString();
    expect(newId).not.toBe('');
    expect(newId).not.toBe(oldId);
    expect(newId).not.toBe(kept.id);
    const expected = [
      { id: kept.id, behavior: 'followUp', message: 'Keep the image', images: [{ type: 'image', mimeType: 'image/png' }] },
      { id: newId, behavior: 'followUp', message: 'Remove this' },
    ];
    expect(withReplacement).toEqual(expected);

    await command(runtime.runtimeId, { type: 'change_pending', id: oldId, action: 'remove' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(expected);

    await command(runtime.runtimeId, { type: 'change_pending', id: newId, action: 'remove' });
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([expected[0]]);
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

test('identical queued messages keep distinct stable identities', async () => {
  const session = publicSession(daemon.home, 'duplicate-queue-text');
  const runtime = await open(session.path, 'duplicate-queue-client');
  try {
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Check again' });
    const first = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(first).toHaveLength(1);
    await command(runtime.runtimeId, { type: 'follow_up', message: 'Check again' });
    const both = (await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(both.map((item: any) => item.message)).toEqual(['Check again', 'Check again']);
    expect(both[0].id).toBe(first[0].id);
    expect(both[1].id).toBeString();
    expect(both[1].id).not.toBe('');
    expect(both[1].id).not.toBe(both[0].id);
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(both);
    expect(await daemon.failure('pi_command', {
      runtimeId: runtime.runtimeId, command: { type: 'change_pending', id: both[0].id, action: 'remove' },
    })).toContain('This queue contains messages that cannot be safely switched');
    expect((await command(runtime.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(both);
  } finally { await daemon.invoke('stop_pi', { runtimeId: runtime.runtimeId }); }
}, 60_000);

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

test('an explicitly read-only view cannot take ownership or change the pending queue', async () => {
  const session = publicSession(daemon.home, 'explicit-readonly');
  const owner = await open(session.path, 'explicit-owner');
  const readerId = randomUUID();
  try {
    await command(owner.runtimeId, { type: 'follow_up', message: 'Protected work' });
    const before = (await command(owner.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(await daemon.invoke('start_pi', {
      runtimeId: readerId, clientId: 'explicit-reader', cwd: daemon.home, sessionPath: session.path, presence: { readOnly: true },
    })).toMatchObject({ owned: false });
    expect((await command(readerId, { type: 'get_state' })).pendingMessages).toEqual(before);
    expect(await daemon.failure('pi_command', { runtimeId: readerId, command: { type: 'take_ownership' } }))
      .toBe('This view is read-only');
    expect(await daemon.failure('pi_command', { runtimeId: readerId, command: { type: 'clear_queue' } })).toContain('ownership');
    expect((await command(owner.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(before);
    await command(owner.runtimeId, { type: 'clear_queue' });
    expect((await command(owner.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([]);
  } finally {
    await daemon.invoke('stop_pi', { runtimeId: readerId });
    await daemon.invoke('stop_pi', { runtimeId: owner.runtimeId });
  }
}, 60_000);

test('a read-only client cannot clear pending messages until it takes ownership', async () => {
  const session = publicSession(daemon.home, 'queue-ownership');
  const owner = await open(session.path, 'queue-owner');
  const reader = await open(session.path, 'queue-reader');
  let ownerStopped = false;
  try {
    expect(reader.owned).toBe(false);
    await command(owner.runtimeId, { type: 'follow_up', message: 'Keep pending work' });
    await command(owner.runtimeId, { type: 'follow_up', message: 'Keep the attachment', images: [
      { type: 'image', mimeType: 'image/png', data: Buffer.from('owned-image').toString('base64') },
    ] });
    const pending = (await command(owner.runtimeId, { type: 'get_state' })).pendingMessages;
    expect(pending.map(({ message, images }: any) => ({ message, images }))).toEqual([
      { message: 'Keep pending work', images: undefined },
      { message: 'Keep the attachment', images: [{ type: 'image', mimeType: 'image/png' }] },
    ]);
    expect(new Set(pending.map((item: any) => item.id)).size).toBe(2);
    expect(await daemon.failure('pi_command', { runtimeId: reader.runtimeId, command: { type: 'clear_queue' } }))
      .toContain('ownership');
    expect((await command(owner.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(pending);
    expect(await command(reader.runtimeId, { type: 'take_ownership' })).toMatchObject({ owned: true });
    // The former owner loses the right to edit the queue as soon as ownership moves.
    expect(await daemon.failure('pi_command', {
      runtimeId: owner.runtimeId, command: { type: 'change_pending', id: pending[0].id, action: 'remove' },
    })).toContain('ownership');
    expect((await command(reader.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(pending);
    // Closing the former owner must keep the shared worker and its queued work alive.
    await daemon.invoke('stop_pi', { runtimeId: owner.runtimeId });
    ownerStopped = true;
    expect((await command(reader.runtimeId, { type: 'get_state' })).pendingMessages).toEqual(pending);
    await command(reader.runtimeId, { type: 'clear_queue' });
    expect((await command(reader.runtimeId, { type: 'get_state' })).pendingMessages).toEqual([]);
  } finally {
    if (!ownerStopped) await daemon.invoke('stop_pi', { runtimeId: owner.runtimeId });
    await daemon.invoke('stop_pi', { runtimeId: reader.runtimeId });
  }
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



test('abort stops an external Pi that never answers the stop request', async () => {
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
  const bootstrap = await startDaemon();
  await bootstrap.stop();
  const session = publicSession(bootstrap.home);
  const first = await startHost({ home: bootstrap.home });
  let second: TestHost | undefined;
  try {
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



test('abort stops Pi while both a goal preparation and the stop request are stuck', async () => {
  const session = publicSession(daemon.home, 'abort-gate');
  const runtime = await open(session.path, 'abort-gate-client');
  const preparation = command(runtime.runtimeId, { type: 'follow_up', message: '/goal inspect the project' })
    .then(() => 'answered', (error: Error) => error.message);
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId
    && packet.event?.type === 'fixture_waiting' && packet.event.command === 'prepare_goal_prompt');
  const started = Date.now();
  const abort = command(runtime.runtimeId, { type: 'abort' });
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId
    && packet.event?.type === 'fixture_waiting' && packet.event.command === 'stop');
  await abort;
  expect(Date.now() - started).toBeLessThan(6000);
  await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtime.runtimeId && packet.event?.type === 'disconnected', 1000);
  expect(await preparation).not.toBe('answered');
  expect(await daemon.failure('pi_command', { runtimeId: runtime.runtimeId, command: { type: 'get_state' } })).toContain('not running');
}, 15_000);
