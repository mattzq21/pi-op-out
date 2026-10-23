import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeProgram, startDaemon, type TestDaemon } from './harness';

/*
 * Closing a new conversation that the user never used removes its transcript. A fake Pi creates the transcript the
 * way a faulty external process can, outside the session store, and reports it in get_state.
 * The file "pi-mode.json" in HOME tells the fake Pi what to write for the next start.
 */
let daemon: TestDaemon;

beforeAll(async () => {
  daemon = await startDaemon();
  const bin = join(daemon.home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', '#!' + process.execPath + '\n' + [
    "const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');",
    "const args = process.argv.slice(2); const flag = name => args[args.lastIndexOf(name) + 1];",
    "const mode = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'pi-mode.json'), 'utf8'));",
    "if (args.includes('--session')) { const sessionFile = flag('--session'); const state = { sessionFile, sessionId: 'opened', isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };",
    "  require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: [] } : null }) + '\\n'); });",
    "} else {",
    "const id = flag('--session-id'); const root = path.join(os.homedir(), '.piop');",
    "const directory = mode.outside ? path.join(os.homedir(), 'outside') : flag('--session-dir'); fs.mkdirSync(directory, { recursive: true });",
    "const sessionFile = path.join(directory, '2026-01-01T00-00-00-000Z_' + id + '.jsonl');",
    "const header = { type: 'session', version: 3, id: mode.headerId ?? id, timestamp: '2026-01-01T00:00:00.000Z', cwd: os.homedir() };",
    "fs.writeFileSync(sessionFile, JSON.stringify(header) + '\\n' + (mode.tail ?? ''));",
    "fs.writeFileSync(path.join(os.homedir(), 'pi-file.txt'), sessionFile);",
    "const state = { sessionFile, sessionId: id, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };",
    "require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line);",
    "  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: [] } : null }) + '\\n'); });",
    "}",
  ].join('\n'));
}, 60_000);
afterAll(() => daemon?.stop());

test('closing never deletes a transcript outside the session store', async () => {
  writeFileSync(join(daemon.home, 'pi-mode.json'), JSON.stringify({ outside: true }));
  const runtimeId = 'outside-chat';
  const applied = daemon.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.type === 'settings_pending' && payload.event.pending === false);
  await daemon.invoke('start_pi', { runtimeId, clientId: 'client', cwd: daemon.home });
  await applied;
  await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_state' } });
  const file = readFileSync(join(daemon.home, 'pi-file.txt'), 'utf8');
  await expect(daemon.invoke('stop_pi', { runtimeId, discardBlank: true }))
    .rejects.toThrow('Conversation is outside session storage');
  expect(file.startsWith(join(daemon.home, 'outside'))).toBe(true);
  expect(existsSync(file)).toBe(true);
}, 30_000);
