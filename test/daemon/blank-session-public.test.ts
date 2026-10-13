import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { startDaemon } from './harness';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

test('closing an unused new conversation removes its header-only transcript', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'unused-conversation';
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: daemon.home, content: '' }),
    }));
    const records = readFileSync(chat.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'session', id: chat.id });
    await daemon.invoke('start_pi', { runtimeId, clientId: 'blank-client', cwd: daemon.home, sessionPath: chat.path });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state.sessionFile).toBe(chat.path);
    expect(state.sessionId).toBe(chat.id);
    const file = state.sessionFile;
    expect(existsSync(file)).toBe(true);
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect((await daemon.invoke('list_sessions')).map((session: any) => session.path)).not.toContain(file);
  } finally { await daemon.stop(); }
}, 30_000);

test('closing keeps a transcript whose header ID changed after opening', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'changed-header';
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: daemon.home, content: '' }),
    }));
    await daemon.invoke('start_pi', { runtimeId, clientId: 'blank-client', cwd: daemon.home, sessionPath: chat.path });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state.sessionFile).toBe(chat.path);
    expect(state.sessionId).toBe(chat.id);
    const lines = readFileSync(chat.path, 'utf8').split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), id: randomUUID() });
    const changed = lines.join('\n');
    writeFileSync(chat.path, changed);
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(true);
    expect(existsSync(chat.path)).toBe(true);
    expect(readFileSync(chat.path, 'utf8')).toBe(changed);
  } finally { await daemon.stop(); }
}, 30_000);

test('closing keeps a conversation that already contains a message', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'saved-message';
  const message = JSON.stringify({ type: 'message', id: 'first-message', parentId: null,
    message: { role: 'user', content: [{ type: 'text', text: 'Keep' }], timestamp: 1 } }) + '\n';
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: daemon.home, content: message }),
    }));
    await daemon.invoke('start_pi', { runtimeId, clientId: 'blank-client', cwd: daemon.home, sessionPath: chat.path });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state.sessionFile).toBe(chat.path);
    expect(state.sessionId).toBe(chat.id);
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(true);
    expect(existsSync(chat.path)).toBe(true);
    expect(readFileSync(chat.path, 'utf8')).toContain(message);
  } finally { await daemon.stop(); }
}, 30_000);

test('closing keeps a transcript with an incomplete final line', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'incomplete-transcript';
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: daemon.home, content: '' }),
    }));
    await daemon.invoke('start_pi', { runtimeId, clientId: 'blank-client', cwd: daemon.home, sessionPath: chat.path });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state.sessionFile).toBe(chat.path);
    expect(state.sessionId).toBe(chat.id);
    const incomplete = readFileSync(chat.path, 'utf8') + 'incomplete json';
    writeFileSync(chat.path, incomplete);
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(true);
    expect(existsSync(chat.path)).toBe(true);
    expect(readFileSync(chat.path, 'utf8')).toBe(incomplete);
  } finally { await daemon.stop(); }
}, 30_000);

test('closing keeps a conversation after a prompt was submitted', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'submitted-prompt';
  const provider = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  try {
    writeFileSync(join(daemon.home, '.piop/models.json'), JSON.stringify({ providers: {
      'blank-session-test': {
        baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: 'openai-completions', apiKey: 'test',
        models: [{ id: 'waiting', contextWindow: 200_000, maxTokens: 4096 }],
      },
    } }));
    const settings = await daemon.invoke('load_app_settings');
    await daemon.invoke('save_app_settings', { settings: { ...settings, defaultModel: 'blank-session-test/waiting' } });
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: daemon.home, content: '' }),
    }));
    await daemon.invoke('start_pi', { runtimeId, clientId: 'blank-client', cwd: daemon.home, sessionPath: chat.path });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    const state = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
    expect(state.sessionFile).toBe(chat.path);
    expect(state.sessionId).toBe(chat.id);
    await daemon.invoke('pi_command', { runtimeId, command: { type: 'prompt', message: 'Keep this' } });
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(false);
    expect(existsSync(chat.path)).toBe(true);
    expect(readFileSync(chat.path, 'utf8').endsWith('\n')).toBe(true);
  } finally {
    provider.stop(true);
    await daemon.stop();
  }
}, 30_000);
