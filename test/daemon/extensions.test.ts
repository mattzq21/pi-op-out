import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { fakePi, fakeProgram, refreshedUsage, startDaemon, temporaryDirectory, type Client, type TestDaemon } from './harness';
import { recordTools } from '../../daemon/src/tool_inventory';

const root = join(import.meta.dir, '../..');
const source = (relative: string) => readFileSync(join(root, relative), 'utf8');
const pluginSource = (relative: string) => source(relative).replaceAll('"../../resources/', '"../../');
const installed = (name: string, relative: string) => name === 'piop-context-window-cap/defaults.ts'
  ? source(relative).replace('../../daemon/resources/session-broker/app-settings.cjs', './app-settings.cjs')
  : name.startsWith('plugins/') ? pluginSource(relative) : source(relative);

function installFakePi(home: string): void {
  const bin = join(home, '.local/bin');
  fakePi(bin);
  fakeProgram(bin, 'node', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = require('node:path');
const launch = { args, root: path.dirname(process.env.PIOP_RPC_ENTRY) };
try {
  const resources = JSON.parse(process.env.PIOP_AGENT_RESOURCES);
  launch.skills = resources.skills;
  launch.tools = resources.tools;
  launch.contextSettings = require(path.join(launch.root, 'app-settings.cjs')).readFile(process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH);
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
    const entry = join(generated, 'piop-define-agents/index.ts');
    expect(readdirSync(folders)).toEqual([basename(generated)]);
    expect(readFileSync(entry, 'utf8')).toBe(source('extensions/piop-define-agents/index.ts'));
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

test('a Pi start loads the published extensions and writes none of them again', async () => {
  const bundles: [string, string][] = [
    ['session-broker.ts', 'daemon/resources/session-broker.ts'],
    ['hooks-extended/index.ts', 'daemon/resources/hooks-extended/index.ts'],
    ['hooks-extended/interface.ts', 'daemon/resources/hooks-extended/interface.ts'],
    ['piop-providers-refresh.ts', 'extensions/piop-providers-refresh/index.ts'],
    ['piop-context-window-cap/defaults.ts', 'extensions/piop-context-window-cap/defaults.ts'],
    ['piop-controls/index.ts', 'daemon/resources/piop-controls/index.ts'],
    ['piop-controls/skills.ts', 'daemon/resources/piop-controls/skills.ts'],
    ['session-broker/queue-tools.ts', 'daemon/resources/session-broker/queue-tools.ts'],
    ['session-broker/context-insertions.ts', 'daemon/resources/session-broker/context-insertions.ts'],
    ['plugins/review/index.ts', 'daemon/plugins/review/index.ts'],
    ['piop-openai-cache-fork.ts', 'extensions/piop-openai-cache-fork/index.ts'],
    ['plugins/web-search/index.ts', 'daemon/plugins/web-search/index.ts'],
  ];
  const first = await launchPublicPi(daemon);
  const generated = first.root;
  expect(generated).toBe(published(join(daemon.home, '.piop')));
  const extensions = extensionPaths(first);
  for (const name of ['hooks-extended/index.ts', 'piop-controls/index.ts', 'session-broker.ts', 'plugins/review/index.ts', 'piop-openai-cache-fork.ts', 'plugins/web-search/index.ts']) expect(extensions).toContain(join(generated, name));
  for (const removed of ['piop-goals/index.ts', 'runtime-settings.ts', 'piop-skills-store/index.ts', 'piop-tool-store/index.ts', 'piop-codemode-tools-description.ts']) expect(extensions).not.toContain(join(generated, removed));
  expect(extensions).toContain(join(generated, 'piop-providers-refresh.ts'));
  expect(extensions.at(-1)).toBe(join(generated, 'piop-controls/skills.ts'));
  const before = new Map<string, number[]>();
  for (const [name, relative] of bundles) {
    expect(readFileSync(join(generated, name), 'utf8')).toBe(installed(name, relative));
    expect(mode(join(generated, name))).toBe(0o600);
    before.set(name, identity(join(generated, name)));
  }
  expect((await launchPublicPi(daemon)).root).toBe(generated);
  for (const [name] of bundles) expect(identity(join(generated, name))).toEqual(before.get(name)!);
}, 60_000);


test('a started Pi receives the reported tools, skill lists and separate context settings', async () => {
  const storage = join(daemon.home, '.piop');
  const skill = join(daemon.home, '.agents/skills/spaced skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: spaced\n---\n');
  await daemon.invoke('load_app_settings', { refreshSkills: true });
  recordTools([{ name: 'web_search', description: 'Search', source: '/ext/web-search.ts' }, { name: 'read', description: 'Read', source: 'builtin:read' }], join(storage, 'settings.json'));
  for (const enabled of [true, false]) {
    const settings = await daemon.invoke('load_app_settings');
    for (const entry of settings.skills) entry.enabled = enabled;
    settings.contextWindowCap = enabled ? 123456 : 200000;
    settings.contextWindowCapEnabled = enabled;
    await daemon.invoke('save_app_settings', { settings });
    const launch = await launchPublicPi(daemon);
    expect(launch.readError).toBeUndefined();
    const generated = launch.root;
    expect(extensionPaths(launch)).toEqual(expect.arrayContaining([join(generated, 'piop-mcp-bridge.ts'), join(generated, 'piop-context-window-cap/index.ts')]));
    expect(readFileSync(join(generated, 'piop-mcp-bridge.ts'), 'utf8')).toBe(source('daemon/resources/mcp-bridge.bundle.mjs'));
    expect(existsSync(join(generated, 'mcp-servers.json'))).toBe(false);
    expect(existsSync(join(storage, 'mcp-servers.json'))).toBe(false);
    expect(readFileSync(join(generated, 'piop-context-window-cap/index.ts'), 'utf8')).toBe(source('extensions/piop-context-window-cap/index.ts').replace('../../daemon/resources/hooks-extended/interface.ts', '../hooks-extended/interface.ts'));
    for (const file of ['piop-mcp-bridge.ts', 'piop-context-window-cap/index.ts']) expect(mode(join(generated, file))).toBe(0o600);
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
    expect(readFileSync(join(published(join(home, '.piop')), 'piop-define-agents/index.ts'), 'utf8')).toBe(source('extensions/piop-define-agents/index.ts'));
    expect(readFileSync(join(legacy, 'index.ts'), 'utf8')).toBe('original');
    expect(readdirSync(join(legacy, 'config.json'))).toEqual([]);
  } finally { await local.stop(); }
}, 60_000);


test('Pi starts from two clients at the same time use the same unchanged files', async () => {
  const second = await daemon.connect();
  const { root } = await launchPublicPi(daemon);
  const entry = join(root, 'piop-mcp-bridge.ts');
  const before = identity(entry);
  for (let round = 0; round < 5; round++) {
    const launched = await Promise.all([launchPublicPi(daemon), launchPublicPi(daemon, second)]);
    expect(launched.map(launch => launch.root)).toEqual([root, root]);
  }
  expect(identity(entry)).toEqual(before);
  expect(readFileSync(entry, 'utf8')).toBe(source('daemon/resources/mcp-bridge.bundle.mjs'));
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
      expect(launch.root).toBe(published(debug.extensionRoot));
      expect(extensionPaths(launch)).toContain(join(launch.root, 'piop-mcp-bridge.ts'));
      expect(readFileSync(join(launch.root, 'piop-mcp-bridge.ts'), 'utf8')).toBe(source('daemon/resources/mcp-bridge.bundle.mjs'));
      expect(extensionPaths(launch)).toContain(join(launch.root, 'piop-providers-refresh.ts'));
      expect(readFileSync(join(launch.root, 'piop-providers-refresh.ts'), 'utf8')).toBe(source('extensions/piop-providers-refresh/index.ts'));
      roots.push(launch.root);
    }
    expect(roots[0]).not.toBe(roots[1]);
    expect(existsSync(join(home, '.piop-dev/generated'))).toBe(false);
  } finally { for (const local of running.reverse()) await local.stop(); }
}, 60_000);
