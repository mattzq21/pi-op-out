import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonExecutable, fakeProgram, startDaemon, synchronizationFinished, temporaryDirectory, type TestDaemon } from './harness';
import { runLimited } from '../../daemon/src/process_io';
import { startHost } from './host-fixture';

function publicSession(home: string, options: { cwd: string; folder: string }): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, ...options, content: '' }),
  }));
}

/**
 * Installs a fake Pi in ~/.local/bin, where the daemon looks first. The daemon starts Pi through
 * "node runtime-bridge.cjs <pi> --mode rpc ...", with the node next to Pi, so the fake node plays Pi's RPC side.
 * Each start appends its arguments, working directory, process ID and the launch environment variables the tests check to ~/launches.jsonl.
 */
function installFakePi(home: string): void {
  const bin = join(home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = flag => { const index = args.lastIndexOf(flag); return index < 0 ? undefined : args[index + 1]; };
fs.appendFileSync(require('node:path').join(process.env.HOME, 'launches.jsonl'), JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, env: Object.fromEntries(['HOME', 'PI_DESKTOP_HOST_ID', 'PIOP_STORAGE_DIRECTORY', 'PI_CODING_AGENT_DIR'].map(key => [key, process.env[key]])) }) + '\\n');
const sessionFile = at('--session');
const sessionId = sessionFile ? JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id : at('--session-id');
// Pi keeps running after its input closes, so only the daemon can end it.
setInterval(() => {}, 1 << 30);
const state = { sessionFile, sessionId, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: sessionFile ? fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)) : [] } : null }) + '\\n');
});
`);
}

type Launch = { args: string[]; cwd: string; pid: number; env: Record<string, string> };
const launches = (home: string): Launch[] => readFileSync(join(home, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

let daemon: TestDaemon;
beforeAll(async () => {
  daemon = await startDaemon();
  installFakePi(daemon.home);
}, 60_000);
afterAll(() => daemon?.stop());

test('Pi starts in the requested directory with each argument kept whole and the launch environment set', async () => {
  const cwd = join(daemon.home, "project with spaces $(literal) 'quoted'");
  mkdirSync(cwd);
  const session = publicSession(daemon.home, { cwd, folder: 'folder with spaces $(literal)' });
  await daemon.invoke('start_pi', { runtimeId: 'launch-runtime', clientId: 'launch-client', cwd, sessionPath: session.path });
  const launch = launches(daemon.home).at(-1)!;
  expect(launch.cwd).toBe(cwd);
  expect(launch.args.slice(1, 4)).toEqual([join(daemon.home, '.local/bin/pi'), '--mode', 'rpc']);
  expect(launch.args[launch.args.lastIndexOf('--session') + 1]).toBe(session.path);
  expect(launch.env).toEqual({ HOME: daemon.home, PI_DESKTOP_HOST_ID: 'local', PIOP_STORAGE_DIRECTORY: '.piop', PI_CODING_AGENT_DIR: join(daemon.home, '.piop') });
  await daemon.invoke('stop_pi', { runtimeId: 'launch-runtime' });
});


test('a local Pi stays attached while remote machines change, and an unknown machine is rejected', async () => {
  const session = publicSession(daemon.home, { cwd: daemon.home, folder: 'transport' });
  await daemon.invoke('start_pi', { runtimeId: 'transport-runtime', clientId: 'transport-client', cwd: daemon.home, sessionPath: session.path });
  const from = daemon.events.length;
  for (const target of ['user@example.com', 'other@example.com']) {
    const settings = await daemon.invoke('load_app_settings');
    settings.hosts = [{ enabled: true, id: 'remote', name: 'Server', target, piPath: '/opt/pi' }];
    await synchronizationFinished(daemon, (await daemon.invoke('save_app_settings', { settings })).revision);
  }
  expect(daemon.events.slice(from).filter(event => event.payload?.runtimeId === 'transport-runtime' && event.payload?.event?.type === 'disconnected')).toEqual([]);
  expect(await daemon.invoke('pi_command', { runtimeId: 'transport-runtime', command: { type: 'get_state' } })).toMatchObject({ sessionFile: session.path });
  expect(await daemon.failure('start_pi', { runtimeId: 'missing-runtime', clientId: 'transport-client', cwd: daemon.home, hostId: 'missing' })).toBe('Unknown host: missing');
  await daemon.invoke('stop_pi', { runtimeId: 'transport-runtime' });
});

test('a rejected host configuration fails the start that needed it, and the host keeps answering later requests', async () => {
  const local = await startDaemon();
  try {
    installFakePi(local.home);
    const open = publicSession(local.home, { cwd: local.home, folder: 'configured' });
    await local.invoke('start_pi', { runtimeId: 'configured-runtime', clientId: 'configuration-client', cwd: local.home, sessionPath: open.path });
    // A new agent configuration makes the host load agent definitions, which needs a working Pi installation.
    const settings = await local.invoke('load_app_settings');
    await local.invoke('save_app_settings', { settings, agentHostId: 'local' });
    const rejected = publicSession(local.home, { cwd: local.home, folder: 'rejected' });
    const start = { runtimeId: 'rejected-runtime', clientId: 'configuration-client', cwd: local.home, sessionPath: rejected.path };
    expect(await local.failure('start_pi', start)).toBe('Extension validation requires a Pi Node installation');
    expect(await local.invoke('pi_command', { runtimeId: 'configured-runtime', command: { type: 'get_state' } })).toMatchObject({ sessionFile: open.path });
  } finally { await local.stop(); }
}, 60_000);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stopping the daemon shuts the host down and ends its Pi processes', async () => {
  const local = await startDaemon();
  let pid: number | undefined;
  try {
    installFakePi(local.home);
    const session = publicSession(local.home, { cwd: local.home, folder: 'shutdown' });
    await local.invoke('start_pi', { runtimeId: 'shutdown-runtime', clientId: 'shutdown-client', cwd: local.home, sessionPath: session.path });
    pid = launches(local.home).at(-1)!.pid;
    expect(alive(pid)).toBe(true);
  } finally { await local.stop(); }
  expect(alive(pid!)).toBe(false);
}, 60_000);

const script = (source: string) => ({ program: process.execPath, args: ['-e', source] });

test('a child receives explicit multiline environment values, omits removed keys, and inherits the working directory', async () => {
  const keys = ['PIOP_PROCESS_TEST_VALUE', 'PIOP_PROCESS_TEST_REMOVED'] as const;
  const previous = keys.map(key => process.env[key]);
  const cwd = process.cwd();
  try {
    process.env.PIOP_PROCESS_TEST_VALUE = 'inherited value';
    process.env.PIOP_PROCESS_TEST_REMOVED = 'inherited key';
    const output = await runLimited({
      ...script(`process.stdout.write(JSON.stringify({
        value: process.env.PIOP_PROCESS_TEST_VALUE,
        removed: Object.hasOwn(process.env, 'PIOP_PROCESS_TEST_REMOVED'),
        cwd: process.cwd()
      }))`),
      env: { PIOP_PROCESS_TEST_VALUE: 'a=b\nnext', PIOP_PROCESS_TEST_REMOVED: undefined },
    }, 64 * 1024, 'process environment');
    expect(output.status.success).toBe(true);
    expect(JSON.parse(output.stdout.toString())).toEqual({ value: 'a=b\nnext', removed: false, cwd });
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
});

test('bounded process output accepts output at its exact limit and keeps a failure status', async () => {
  const output = await runLimited(script("process.stdout.write(Buffer.from([0,255,10,65]));process.stderr.write('diagnostic');process.exitCode=7"), 4, 'test command');
  expect([...output.stdout]).toEqual([0, 255, 10, 65]);
  expect(output.stderr.toString()).toBe('diagnostic');
  expect(output.status).toEqual({ code: 7, signal: null, success: false });
  const empty = await runLimited(script('void 0'), 0, 'empty command');
  expect(empty.status.success).toBe(true);
  expect(empty.stdout.length + empty.stderr.length).toBe(0);
});

test('bounded process output rejects too much output, keeps only the first 64 KiB of diagnostics, and reports a missing program', async () => {
  await expect(runLimited(script("process.stdout.write('12345')"), 4, 'Process capture')).rejects.toThrow(/^Process capture: output exceeded 4 bytes$/);
  const output = await runLimited(script("process.stderr.write('prefix' + 'x'.repeat(200000)); process.stdout.write('done')"), 4, 'large diagnostics');
  expect(output.status.success).toBe(true);
  expect(output.stdout.toString()).toBe('done');
  expect(output.stderr.length).toBe(64 * 1024);
  expect(output.stderr.subarray(0, 6).toString()).toBe('prefix');
  const missing = join(temporaryDirectory('piop-process-'), 'missing-executable');
  await expect(runLimited({ program: missing }, 4, 'Start helper')).rejects.toThrow(/^Start helper: /);
});

const configuration = { settings: {}, autoCompaction: true, autoRetry: false, agentRevision: 0 };

test('a shutdown packet gets no reply, later packets are ignored, and the host finishes once', async () => {
  const host = await startHost();
  try {
    expect(await host.request({ type: 'configure', configuration })).toBeNull();
    // Requests the host never answers end only when the host process ends, which the fixture reports as "Host stopped".
    const unanswered = [{ type: 'shutdown' }, { type: 'configure', configuration }, { type: 'shutdown' }].map(packet => host.request(packet, 30_000).then(() => 'answered', (error: Error) => error.message));
    await host.finished;
    expect(await Promise.all(unanswered)).toEqual(['Host stopped', 'Host stopped', 'Host stopped']);
    expect(host.events.filter(packet => packet.type === 'response')).toEqual([]);
  } finally { await host.stop(); }
}, 60_000);

test('stopping the daemon warns connected clients before the connection closes', async () => {
  const local = await startDaemon();
  try {
    const child = Bun.spawn([process.execPath, await daemonExecutable(), 'stop'], { env: { ...process.env, HOME: local.home }, stdout: 'pipe', stderr: 'pipe' });
    await child.exited;
    await local.waitEvent('pi://daemon-restarting');
  } finally { await local.stop(); }
  expect(local.events.some(event => event.event === 'pi://daemon-restarting' && event.payload.hostId === 'local')).toBe(true);
}, 60_000);
