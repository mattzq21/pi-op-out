import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakePi, fakeProgram, startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => {
  daemon = await startDaemon();
  const bin = join(daemon.home, '.local/bin');
  fakePi(daemon.home);
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

test('a Pi that saves its transcript outside the session store does not start, and its transcript stays', async () => {
  writeFileSync(join(daemon.home, 'pi-mode.json'), JSON.stringify({ outside: true }));
  const runtimeId = 'outside-chat';
  await expect(daemon.invoke('start_pi', { runtimeId, clientId: 'client', cwd: daemon.home }))
    .rejects.toThrow('Conversation is outside session storage');
  const file = readFileSync(join(daemon.home, 'pi-file.txt'), 'utf8');
  expect(file.startsWith(join(daemon.home, 'outside'))).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(false);
  expect(existsSync(file)).toBe(true);
}, 30_000);
