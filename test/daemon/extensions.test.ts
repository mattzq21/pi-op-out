import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { daemonDirectory, fakePi, fakeProgram, refreshedUsage, startDaemon, temporaryDirectory, type Client, type TestDaemon } from './harness';
import { recordTools } from '../../daemon/src/tool_inventory';

const root = join(import.meta.dir, '../..');
const CORE_FILES = [
  'piop-ocx-provider.mjs', 'piop-providers-refresh.mjs', 'piop-mcp-bridge.mjs', 'piop-storage.mjs', 'hooks-extended.mjs', 'piop-controls.mjs',
  'session-broker.mjs', 'piop-compaction-timing.mjs', 'plugins/review.mjs', 'plugins/btw.mjs', 'piop-context-window-cap.mjs', 'piop-context-bar.mjs',
  'plugins/cost.mjs', 'plugins/web-search.mjs', 'piop-openai-fast-mode.mjs', 'piop-openai-cache-fork.mjs', 'piop-define-agents.mjs', 'skills.mjs',
];
const PUBLISHED = [...CORE_FILES, 'provider-sdk.mjs', 'runtime-bridge.cjs'].sort();
const files = (folder: string): string[] => readdirSync(folder, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1)).sort();

function installFakePi(home: string): void {
  const bin = join(home, '.local/bin');
  fakePi(home);
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = require('node:path');
const launch = { args, root: path.dirname(process.env.PIOP_RPC_ENTRY) };
try {
  const resources = JSON.parse(process.env.PIOP_AGENT_RESOURCES);
  launch.skills = resources.skills;
  launch.tools = resources.tools;
  launch.contextSettings = JSON.parse(process.env.PIOP_CONTEXT_CAP_SETTINGS);
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

type Launch = { args: string[]; root: string; contextSettings?: any; skills?: any; tools?: any; readError?: string };
const lastLaunch = (home: string): Launch => JSON.parse(readFileSync(join(home, 'launches.jsonl'), 'utf8').trim().split('\n').at(-1)!);
const extensionPaths = ({ args }: Launch) => args.flatMap((arg, index) => args[index - 1] === '--extension' ? [arg] : []);
const identity = (path: string) => { const stats = statSync(path); return [stats.ino, stats.mtimeMs]; };
function published(base: string): string {
  const names = readdirSync(join(base, 'generated')).filter(name => !name.startsWith('.'));
  expect(names).toHaveLength(1);
  return join(base, 'generated', names[0]!);
}

let launches = 0;
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
  expect((await refreshedUsage(daemon, 'codex')).usage).toEqual({ remainingPercent: 25, resetAt: 200 });
});

const mode = (path: string) => statSync(path).mode & 0o777;

test('daemon startup publishes the Pi extensions once in a folder named by their content, removes old folders and leaves the old Pi agent folder alone', async () => {
  const home = temporaryDirectory('piop-home-');
  const legacy = join(home, '.pi/agent/extensions/pi-define-agents');
  mkdirSync(legacy, { recursive: true });
  const original = '{"agents":[{"name":"custom"}]}\n';
  writeFileSync(join(legacy, 'config.json'), original);
  writeFileSync(join(legacy, 'index.ts'), 'old extension');
  writeFileSync(join(legacy, 'notes.txt'), 'keep');
  const folders = join(home, '.piop/generated');
  mkdirSync(join(folders, 'old-build'), { recursive: true });
  writeFileSync(join(folders, 'old-build/index.ts'), 'old build');
  mkdirSync(join(folders, '.tmp-interrupted'));
  let local = await startDaemon({ home });
  try {
    const generated = published(join(home, '.piop'));
    const entry = join(generated, 'plugins/review.mjs');
    expect(readdirSync(folders)).toEqual([basename(generated)]);
    expect(files(generated)).toEqual(PUBLISHED);
    expect(mode(entry)).toBe(0o600);
    expect(mode(dirname(entry))).toBe(0o700);
    expect(mode(generated)).toBe(0o700);
    const before = identity(entry);
    await local.stop();
    local = await startDaemon({ home });
    expect(published(join(home, '.piop'))).toBe(generated);
    expect(identity(entry)).toEqual(before);
    expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(legacy, 'index.ts'), 'utf8')).toBe('old extension');
    expect(readFileSync(join(legacy, 'notes.txt'), 'utf8')).toBe('keep');
  } finally { await local.stop(); }
}, 60_000);

test('a Pi start loads each published extension as one file and writes none of them again', async () => {
  const first = await launchPublicPi(daemon);
  const generated = first.root;
  expect(generated).toBe(published(join(daemon.home, '.piop')));
  expect(extensionPaths(first)).toEqual(['builtin:codemode', 'builtin:tool-search', ...CORE_FILES.map(name => join(generated, name))]);
  const before = new Map(files(generated).map(name => [name, identity(join(generated, name))]));
  for (const name of before.keys()) expect(mode(join(generated, name))).toBe(0o600);
  expect((await launchPublicPi(daemon)).root).toBe(generated);
  for (const [name, saved] of before) expect(identity(join(generated, name))).toEqual(saved);
}, 60_000);


test('a started Pi receives the reported tools, skill lists and separate context settings', async () => {
  const storage = join(daemon.home, '.piop');
  const skill = join(daemon.home, '.agents/skills/spaced skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: spaced\n---\n');
  await daemon.invoke('load_app_settings', { refreshSkills: true });
  recordTools([{ name: 'web_search', description: 'Search', source: '/ext/web-search.ts' }, { name: 'read', description: 'Read', source: 'builtin:read' }], storage);
  for (const enabled of [true, false]) {
    const settings = await daemon.invoke('load_app_settings');
    for (const entry of settings.skills) entry.enabled = enabled;
    settings.contextWindowCap = enabled ? 123456 : 200000;
    settings.contextWindowCapEnabled = enabled;
    await daemon.invoke('save_app_settings', { settings });
    const launch = await launchPublicPi(daemon);
    expect(launch.readError).toBeUndefined();
    const generated = launch.root;
    expect(extensionPaths(launch)).toEqual(expect.arrayContaining([join(generated, 'piop-mcp-bridge.mjs'), join(generated, 'piop-context-window-cap.mjs')]));
    expect(existsSync(join(generated, 'mcp-servers.json'))).toBe(false);
    expect(existsSync(join(storage, 'mcp-servers.json'))).toBe(false);
    expect(launch.contextSettings).toEqual({ contextWindowCap: enabled ? 123456 : 200000, contextWindowCapEnabled: enabled, modelContextWindowCaps: {} });
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

test('daemon startup ignores an obstructed old Pi agent configuration and leaves it unchanged', async () => {
  const home = temporaryDirectory('piop-home-');
  const legacy = join(home, '.pi/agent/extensions/pi-define-agents');
  mkdirSync(join(legacy, 'config.json'), { recursive: true });
  writeFileSync(join(legacy, 'index.ts'), 'original');
  const local = await startDaemon({ home });
  try {
    expect(files(published(join(home, '.piop')))).toEqual(PUBLISHED);
    expect(readFileSync(join(legacy, 'index.ts'), 'utf8')).toBe('original');
    expect(readdirSync(join(legacy, 'config.json'))).toEqual([]);
  } finally { await local.stop(); }
}, 60_000);


test('Pi starts from two clients at the same time use the same unchanged files', async () => {
  const second = await daemon.connect();
  const { root } = await launchPublicPi(daemon);
  const entry = join(root, 'piop-mcp-bridge.mjs');
  const before = identity(entry);
  for (let round = 0; round < 5; round++) {
    const launched = await Promise.all([launchPublicPi(daemon), launchPublicPi(daemon, second)]);
    expect(launched.map(launch => launch.root)).toEqual([root, root]);
  }
  expect(identity(entry)).toEqual(before);
}, 60_000);


test('each development checkout keeps its storage and Pi extensions in its own daemon directory', async () => {
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
      expect(debug.daemonDirectory).toBe(daemonDirectory(home, { development: true, projectRoot }));
      expect(debug.extensionRoot).toBe(debug.daemonDirectory);
      await local.invoke('start_pi', { runtimeId: 'development-runtime', clientId: 'test-client', cwd: home });
      const launch = lastLaunch(home);
      expect(launch.readError).toBeUndefined();
      expect(launch.root).toBe(published(debug.extensionRoot));
      expect(files(launch.root)).toEqual(PUBLISHED);
      expect(extensionPaths(launch)).toContain(join(launch.root, 'piop-mcp-bridge.mjs'));
      roots.push(launch.root);
    }
    expect(roots[0]).not.toBe(roots[1]);
    expect(existsSync(join(home, '.piop-dev/generated'))).toBe(false);
    expect(existsSync(join(home, '.piop-dev/sessions.sqlite'))).toBe(false);
  } finally { for (const local of running.reverse()) await local.stop(); }
}, 60_000);
