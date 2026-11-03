import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakePi, fakeProgram, startDaemon, type TestDaemon } from './harness';

function publicSession(): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, cwd: daemon.home, folder: 'broker', content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Hello', timestamp: 1 } }) + '\n' }),
  }));
}

let daemon: TestDaemon;
let open: { id: string; path: string };
let closed: { id: string; path: string };
let pi: { answers: Record<string, any> };

function installFakePi(home: string, unknownHost: string): void {
  const bin = join(home, '.local/bin');
  fakePi(bin);
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const sessionFile = args[args.lastIndexOf('--session') + 1];
const sessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id;
const state = { sessionFile, sessionId, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
const requests = {
  agents: { path: '/agents' },
  unknown: { path: '/unknown', body: {} },
  host: { path: '/orchestration', body: { action: 'read', hostId: ${JSON.stringify(unknownHost)}, sessionId: ${JSON.stringify(randomUUID())} } },
};
const answers = {};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const trigger = setInterval(() => {
  if (!fs.existsSync(path.join(process.env.HOME, 'pi-trigger'))) return;
  clearInterval(trigger);
  for (const [id, data] of Object.entries(requests)) send({ type: 'piop_runtime_event', id, name: 'broker', data });
}, 20);
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'piop_runtime_event_result') {
    answers[request.id] = request.data;
    if (Object.keys(answers).length === Object.keys(requests).length) {
      fs.writeFileSync(path.join(process.env.HOME, 'pi-broker.json'), JSON.stringify({ answers }));
    }
    return;
  }
  send({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: [], leafId: null } : null });
});
`);
}

beforeAll(async () => {
  daemon = await startDaemon();
  installFakePi(daemon.home, 'café 🦆');
  open = publicSession();
  closed = publicSession();
  expect(await daemon.invoke('start_pi', { runtimeId: 'open-runtime', clientId: 'test-client', cwd: daemon.home, sessionPath: open.path })).toMatchObject({ owned: true });
  writeFileSync(join(daemon.home, 'pi-trigger'), '');
  const file = join(daemon.home, 'pi-broker.json');
  for (const deadline = Date.now() + 30_000; !existsSync(file);) {
    if (Date.now() > deadline) throw new Error('Pi got no broker answers');
    await Bun.sleep(50);
  }
  pi = JSON.parse(readFileSync(file, 'utf8'));
}, 60_000);
afterAll(async () => { await daemon?.stop(); });

test('a started Pi reaches the broker through its own channel', () => {
  expect(Array.isArray(pi.answers.agents.data)).toBe(true);
});

test('broker failures reach Pi as errors that say if a retry can work', () => {
  expect(pi.answers.unknown).toEqual({ error: 'Unknown session broker endpoint', transient: false });
  expect(pi.answers.host).toEqual({ error: 'Unknown host: café 🦆', transient: false });
});

test('the agent list marks open conversations as active', () => {
  const listed = new Map(pi.answers.agents.data.map((agent: any) => [agent.sessionId, agent.active]));
  expect(listed.get(open.id)).toBe(true);
  expect(listed.get(closed.id)).toBe(false);
});
