import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fakeProgram, startDaemon, temporaryDirectory, type Client, type TestDaemon } from './harness';
import { recordTools } from '../../daemon/src/tool_inventory';

const root = join(import.meta.dir, '../..');
const source = (relative: string) => readFileSync(join(root, relative), 'utf8');

/**
 * Installs a fake Pi in ~/.local/bin, where the daemon looks first. The daemon starts Pi through
 * "node runtime-bridge.cjs <pi> --mode rpc ...", with the node next to Pi, so the fake node plays Pi's RPC side.
 * Each start reads its runtime and context window settings the way Pi's extensions do, through the generated
 * app-settings.cjs, and appends them with its arguments to ~/launches.jsonl.
 */
function installFakePi(home: string): void {
  const bin = join(home, '.local/bin');
  fakeProgram(bin, 'pi', '#!/bin/sh\nexit 1\n');
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = require('node:path');
const launch = { args };
try {
  const resources = JSON.parse(process.env.PIOP_AGENT_RESOURCES);
  launch.skills = resources.skills;
  launch.tools = resources.tools;
  const read = record => require(path.join(path.dirname(record), 'app-settings.cjs')).readFile(record);
  launch.contextSettings = read(process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH);
} catch (error) { launch.readError = String(error?.message ?? error); }
fs.appendFileSync(path.join(process.env.HOME, 'launches.jsonl'), JSON.stringify(launch) + '\\n');
const sessionFile = args.includes('--session') ? args[args.lastIndexOf('--session') + 1] : undefined;
const sessionId = sessionFile ? JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\\n')[0]).id : args[args.lastIndexOf('--session-id') + 1];
const state = { sessionFile, sessionId, isStreaming: false, messageCount: 0, pendingMessageCount: 0, model: null, thinkingLevel: 'medium' };
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'piop_request' && ['context_cap_settings'].includes(request.command)) {
    process.stdout.write(JSON.stringify({ type: 'fixture_settings', command: request.command, settings: request.payload.settings }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: request.type === 'get_state' ? state : request.type === 'get_entries' ? { entries: [], leafId: null } : null }) + '\\n');
});
`);
}

type Launch = { args: string[]; contextSettings?: any; skills?: any; tools?: any; readError?: string };
const lastLaunch = (home: string): Launch => JSON.parse(readFileSync(join(home, 'launches.jsonl'), 'utf8').trim().split('\n').at(-1)!);
const extensionPaths = ({ args }: Launch) => args.flatMap((arg, index) => args[index - 1] === '--extension' ? [arg] : []);

let launches = 0;
/** Opens a new conversation in Pi through the given client and resolves with what that Pi start received. */
async function launchPublicPi(daemon: TestDaemon, client: Client = daemon): Promise<Launch> {
  const { path } = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home: daemon.home, cwd: daemon.home, folder: 'launch', content: '' }),
  }));
  await client.invoke('start_pi', { runtimeId: 'runtime-' + ++launches, clientId: 'test-client', cwd: daemon.home, sessionPath: path });
  return lastLaunch(daemon.home);
}
let daemon: TestDaemon;

beforeAll(async () => {
  daemon = await startDaemon();
  installFakePi(daemon.home);
}, 60_000);
afterAll(() => daemon?.stop());

test('Codex usage completes the server handshake and returns the limiting window', async () => {
  fakeProgram(daemon.bin, 'codex', `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(9);
let initialized = false;
let ready = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const packet = JSON.parse(line);
  const reply = result => console.log(JSON.stringify({ id: packet.id, result }));
  const reject = message => console.log(JSON.stringify({ id: packet.id, error: { code: -32600, message } }));
  if (packet.method === 'initialize') {
    if (!packet.params?.clientInfo?.name || !packet.params.clientInfo.version) return reject('Client identity is required');
    initialized = true;
    console.log('startup noise');
    return reply({});
  }
  if (packet.method === 'initialized') { ready = initialized; return; }
  if (packet.method === 'account/rateLimits/read') {
    if (!ready) return reject('Initialize the server before reading account limits');
    return reply({ rateLimits: { primary: { usedPercent: 20, resetsAt: 100 }, secondary: { usedPercent: 75, resetsAt: 200 } } });
  }
  reject('Unsupported test server method');
});
`);
  expect(await daemon.invoke('codex_usage')).toEqual({ remainingPercent: 25, resetAt: 200 });
});

const mode = (path: string) => statSync(path).mode & 0o777;

test('daemon startup installs the defined agents extension, refreshes it on restart and leaves the old Pi agent folder alone', async () => {
  const home = temporaryDirectory('piop-home-');
  const legacy = join(home, '.pi/agent/extensions/pi-define-agents');
  mkdirSync(legacy, { recursive: true });
  const original = '{"agents":[{"name":"custom"}]}\n';
  writeFileSync(join(legacy, 'config.json'), original);
  writeFileSync(join(legacy, 'index.ts'), 'old extension');
  writeFileSync(join(legacy, 'notes.txt'), 'keep');
  const expected = readFileSync(join(root, 'extensions/piop-define-agents/index.ts'), 'utf8');
  const entry = join(home, '.piop/piop-define-agents/index.ts');
  let local = await startDaemon({ home });
  try {
    expect(readFileSync(entry, 'utf8')).toBe(expected);
    expect(mode(entry)).toBe(0o600);
    expect(mode(join(home, '.piop/piop-define-agents'))).toBe(0o700);
    expect(existsSync(join(home, '.piop/piop-define-agents/config.json'))).toBe(false);
    writeFileSync(entry, 'outdated extension');
    await local.stop();
    local = await startDaemon({ home });
    expect(readFileSync(entry, 'utf8')).toBe(expected);
    expect(existsSync(join(home, '.piop/piop-define-agents/config.json'))).toBe(false);
    expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(legacy, 'index.ts'), 'utf8')).toBe('old extension');
    expect(readFileSync(join(legacy, 'notes.txt'), 'utf8')).toBe('keep');
  } finally { await local.stop(); }
}, 60_000);

test('a Pi start installs the bundled extensions as private files and refreshes stale copies without touching other files', async () => {
  const generated = join(daemon.home, '.piop');
  const bundles: [string, string][] = [
    ['session-broker.ts', 'daemon/resources/session-broker.ts'],
    ['hooks-extended/index.ts', 'daemon/resources/hooks-extended/index.ts'],
    ['hooks-extended/interface.ts', 'daemon/resources/hooks-extended/interface.ts'],
    ['piop-providers-refresh.ts', 'extensions/piop-providers-refresh/index.ts'],
    ['piop-context-window-cap/defaults.ts', 'extensions/piop-context-window-cap/defaults.ts'],
    ['piop-controls/index.ts', 'daemon/resources/piop-controls/index.ts'],
    ['piop-goals/index.ts', 'daemon/resources/piop-goals/index.ts'],
    ['plugins/review/index.ts', 'daemon/plugins/review/index.ts'],
    ['piop-openai-cache-fork.ts', 'extensions/piop-openai-cache-fork/index.ts'],
    ['piop-codex-web-search.ts', 'extensions/piop-codex-web-search/index.ts'],
  ];
  const extensions = extensionPaths(await launchPublicPi(daemon));
  for (const name of ['hooks-extended/index.ts', 'piop-controls/index.ts', 'session-broker.ts', 'piop-goals/index.ts', 'plugins/review/index.ts', 'piop-openai-cache-fork.ts', 'piop-codex-web-search.ts']) expect(extensions).toContain(join(generated, name));
  for (const removed of ['runtime-settings.ts', 'piop-skills-store/index.ts', 'piop-tool-store/index.ts', 'piop-codemode-tools-description.ts']) expect(extensions).not.toContain(join(generated, removed));
  expect(extensions).toContain(join(generated, 'piop-providers-refresh.ts'));
  for (const [name, relative] of bundles) {
    expect(readFileSync(join(generated, name), 'utf8')).toBe(name === 'piop-context-window-cap/defaults.ts' ? source(relative).replace('../../daemon/resources/session-broker/app-settings.cjs', './app-settings.cjs') : source(relative));
    expect(mode(join(generated, name))).toBe(0o600);
    writeFileSync(join(generated, name), 'stale bundle');
  }
  expect(mode(generated)).toBe(0o700);
  writeFileSync(join(generated, 'user-file'), 'keep');
  await launchPublicPi(daemon);
  for (const [name, relative] of bundles) expect(readFileSync(join(generated, name), 'utf8')).toBe(name === 'piop-context-window-cap/defaults.ts' ? source(relative).replace('../../daemon/resources/session-broker/app-settings.cjs', './app-settings.cjs') : source(relative));
  expect(readFileSync(join(generated, 'user-file'), 'utf8')).toBe('keep');
}, 60_000);


test('a started Pi receives the reported tools, skill lists and separate context settings', async () => {
  const generated = join(daemon.home, '.piop');
  const skill = join(daemon.home, '.agents/skills/spaced skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: spaced\n---\n');
  await daemon.invoke('load_app_settings', { refreshSkills: true });
  recordTools([{ name: 'web_search', description: 'Search', source: '/ext/web-search.ts' }, { name: 'read', description: 'Read', source: 'builtin:read' }], join(generated, 'settings.json'));
  for (const enabled of [true, false]) {
    const settings = await daemon.invoke('load_app_settings');
    for (const entry of settings.skills) entry.enabled = enabled;
    settings.contextWindowCap = enabled ? 123456 : 200000;
    settings.contextWindowCapEnabled = enabled;
    await daemon.invoke('save_app_settings', { settings });
    const launch = await launchPublicPi(daemon);
    expect(launch.readError).toBeUndefined();
    expect(extensionPaths(launch)).toEqual(expect.arrayContaining([join(generated, 'piop-mcp-bridge.ts'), join(generated, 'piop-context-window-cap/index.ts')]));
    expect(readFileSync(join(generated, 'piop-mcp-bridge.ts'), 'utf8')).toBe(source('daemon/resources/mcp-bridge.bundle.mjs'));
    expect(existsSync(join(generated, 'mcp-servers.json'))).toBe(false);
    expect(readFileSync(join(generated, 'piop-context-window-cap/index.ts'), 'utf8')).toBe(source('extensions/piop-context-window-cap/index.ts').replace('../../daemon/resources/hooks-extended/interface.ts', '../hooks-extended/interface.ts'));
    for (const file of ['piop-mcp-bridge.ts', 'piop-context-window-cap/index.ts']) expect(mode(join(generated, file))).toBe(0o600);
    expect(launch.contextSettings).toEqual({ contextWindowCap: enabled ? 123456 : 200000, contextWindowCapEnabled: enabled, modelContextWindowCaps: {} });
    // A new Pi gets the tools that Pi last reported on the host.
    expect(launch.tools).toEqual({ enabledTools: ['read', 'web_search'], registeredTools: ['read', 'web_search'] });
    expect(launch.skills).toEqual({ userInvokedSkills: [], agentInvokedSkills: enabled ? [skill] : [] });
  }
  rmSync(skill, { recursive: true, force: true });
  await daemon.invoke('load_app_settings', { refreshSkills: true });
}, 60_000);

test('saved context settings reach a running Pi through their own request', async () => {
  await launchPublicPi(daemon);
  const runtimeId = 'runtime-' + launches;
  const settings = await daemon.invoke('load_app_settings');
  settings.contextWindowCap = 456789;
  settings.modelContextWindowCaps = { 'test/model': null };
  const received = daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
    && packet.event?.type === 'fixture_settings' && packet.event.command === 'context_cap_settings'
    && packet.event.settings?.contextWindowCap === 456789);
  await daemon.invoke('save_app_settings', { settings });
  const packet = await received;
  expect(packet.event.settings).toEqual({ contextWindowCap: 456789, contextWindowCapEnabled: settings.contextWindowCapEnabled, modelContextWindowCaps: { 'test/model': null } });
  await daemon.invoke('stop_pi', { runtimeId });
}, 60_000);

test('a Pi start repairs the permissions of unchanged extension files and restores changed files', async () => {
  const generated = join(daemon.home, '.piop');
  const entry = join(generated, 'piop-codex-web-search.ts');
  await launchPublicPi(daemon);
  chmodSync(entry, 0o644);
  chmodSync(generated, 0o755);
  await launchPublicPi(daemon);
  expect(readFileSync(entry, 'utf8')).toBe(source('extensions/piop-codex-web-search/index.ts'));
  expect(mode(entry)).toBe(0o600);
  expect(mode(generated)).toBe(0o700);
  writeFileSync(entry, 'replacement');
  await launchPublicPi(daemon);
  expect(readFileSync(entry, 'utf8')).toBe(source('extensions/piop-codex-web-search/index.ts'));
  expect(mode(entry)).toBe(0o600);
  expect(readdirSync(generated).filter(name => name.endsWith('.tmp'))).toEqual([]);
}, 60_000);

test('daemon startup ignores an obstructed old Pi agent configuration and leaves it unchanged', async () => {
  const home = temporaryDirectory('piop-home-');
  const legacy = join(home, '.pi/agent/extensions/pi-define-agents');
  mkdirSync(join(legacy, 'config.json'), { recursive: true });
  writeFileSync(join(legacy, 'index.ts'), 'original');
  const local = await startDaemon({ home });
  try {
    expect(readFileSync(join(home, '.piop/piop-define-agents/index.ts'), 'utf8')).toBe(source('extensions/piop-define-agents/index.ts'));
    expect(readFileSync(join(legacy, 'index.ts'), 'utf8')).toBe('original');
    expect(readdirSync(join(legacy, 'config.json'))).toEqual([]);
  } finally { await local.stop(); }
}, 60_000);


/**
 * Runs a separate process that keeps reading a file until stopped and then prints how often it saw each allowed
 * content, plus the sizes of any other content and any read errors.
 */
async function watchFile(path: string, allowed: Record<string, string>): Promise<{ stop(): Promise<any> }> {
  const stopFile = path + '.watch-stop';
  const allowedFile = join(temporaryDirectory('piop-watch-'), 'allowed.json');
  writeFileSync(allowedFile, JSON.stringify(allowed));
  const reader = spawn(process.execPath, ['-e', `
const fs = require('node:fs');
const [path, stopFile, allowedFile] = process.argv.slice(1);
const allowed = Object.entries(JSON.parse(fs.readFileSync(allowedFile, 'utf8')));
const seen = Object.fromEntries(allowed.map(([name]) => [name, 0]));
const other = []; const errors = [];
console.log('ready');
while (!fs.existsSync(stopFile)) {
  let body;
  try { body = fs.readFileSync(path, 'utf8'); } catch (error) { if (errors.length < 10) errors.push(error.message); continue; }
  const match = allowed.find(([, content]) => content === body);
  if (match) seen[match[0]]++; else if (other.length < 10) other.push(body.length);
}
console.log(JSON.stringify({ seen, other, errors }));
`, path, stopFile, allowedFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  const closed = new Promise<void>(done => reader.on('close', () => done()));
  await new Promise<void>((done, fail) => {
    reader.stdout!.on('data', chunk => { output += chunk; if (output.startsWith('ready\n')) done(); });
    reader.on('close', () => fail(new Error('File reader ended early: ' + output)));
  });
  return {
    async stop() {
      writeFileSync(stopFile, '');
      await closed;
      rmSync(stopFile);
      return JSON.parse(output.slice('ready\n'.length));
    },
  };
}

test('another process never reads a partial extension file while two clients start Pi at the same time', async () => {
  const generated = join(daemon.home, '.piop');
  const entry = join(generated, 'piop-mcp-bridge.ts');
  const expected = source('daemon/resources/mcp-bridge.bundle.mjs');
  const second = await daemon.connect();
  await launchPublicPi(daemon);
  const watcher = await watchFile(entry, { stale: 'stale bundle', expected });
  try {
    for (let round = 0; round < 10; round++) {
      // Make the file stale with a rename, so the watcher never sees a partial stale file.
      writeFileSync(join(daemon.home, 'stale-bundle'), 'stale bundle');
      renameSync(join(daemon.home, 'stale-bundle'), entry);
      await Promise.all([launchPublicPi(daemon), launchPublicPi(daemon, second)]);
      expect(readFileSync(entry, 'utf8')).toBe(expected);
    }
  } finally {
    const result = await watcher.stop();
    expect(result.other).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.seen.stale).toBeGreaterThan(0);
    expect(result.seen.expected).toBeGreaterThan(0);
  }
}, 60_000);


test('development Pi extensions stay inside their daemon directory across two projects', async () => {
  const home = temporaryDirectory('piop-development-home-');
  const projects = [temporaryDirectory('piop-project-a-'), temporaryDirectory('piop-project-b-')];
  const running: TestDaemon[] = [];
  const roots: string[] = [];
  try {
    for (const projectRoot of projects) {
      const local = await startDaemon({ home, development: true, projectRoot });
      running.push(local);
    }
    installFakePi(home);
    for (const [index, local] of running.entries()) {
      const projectRoot = projects[index];
      const debug = await local.invoke('debug_runtime');
      expect(debug.project).toBe(projectRoot);
      expect(debug.extensionRoot).toBe(join(debug.daemonDirectory, 'extensions'));
      await local.invoke('start_pi', { runtimeId: 'development-runtime', clientId: 'test-client', cwd: home });
      const launch = lastLaunch(home);
      expect(launch.readError).toBeUndefined();
      expect(extensionPaths(launch)).toContain(join(debug.extensionRoot, 'piop-mcp-bridge.ts'));
      expect(readFileSync(join(debug.extensionRoot, 'piop-mcp-bridge.ts'), 'utf8')).toBe(source('daemon/resources/mcp-bridge.bundle.mjs'));
      expect(extensionPaths(launch)).toContain(join(debug.extensionRoot, 'piop-providers-refresh.ts'));
      expect(readFileSync(join(debug.extensionRoot, 'piop-providers-refresh.ts'), 'utf8')).toBe(source('extensions/piop-providers-refresh/index.ts'));
      roots.push(debug.extensionRoot);
    }
    expect(roots[0]).not.toBe(roots[1]);
    writeFileSync(join(home, '.piop-dev/piop-mcp-bridge.ts'), 'other development build');
    writeFileSync(join(roots[1]!, 'piop-mcp-bridge.ts'), 'second project changed');
    expect(readFileSync(join(roots[0]!, 'piop-mcp-bridge.ts'), 'utf8')).toBe(source('daemon/resources/mcp-bridge.bundle.mjs'));
  } finally { for (const local of running.reverse()) await local.stop(); }
}, 60_000);
