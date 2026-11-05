import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { skillMcp, SKILL_MCP_FAILED } from '../../daemon/resources/mcp/skill-mcp.ts';
import { EventEmitter } from 'node:events';
import { installConnectionEvents } from '../../daemon/resources/mcp/connections.ts';

class Connection {
  constructor(name) { this.name = name; }
  changed() {}
}
installConnectionEvents(Connection);

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'piop-skill-mcp-'));
  const handlers = new Map(), servers = new Map(), calls = [], removed = [];
  const bus = new EventEmitter(), statuses = new Map(), connections = new Map();
  const connection = (name, state, error) => {
    const value = connections.get(name) ?? new Connection(name); connections.set(name, value);
    Object.assign(value, { state, error }); value.changed();
  };
  let failure, wait = async () => {}, ready = async () => {};
  const entries = [], commands = [];
  const ctx = { cwd: root, sessionManager: { getBranch: () => entries }, ui: { setStatus(key, value) { statuses.set(key, value); }, notify() {} } };
  const pi = {
    getCommands: () => commands,
    on(name, handler) { handlers.set(name, handler); },
    events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); } },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    registerMcpServer(name, config) {
      if (failure?.(name)) throw new Error('registration failed');
      calls.push({ name, config }); servers.set(name, config);
      connections.delete(name); connection(name, 'connected');
    },
    unregisterMcpServer(name) { removed.push(name); servers.delete(name); },
    getMcpServers: () => [...servers].map(([name, config]) => ({ name, config, extensionPath: 'extension' })),
  };
  const loader = skillMcp(pi, ctx => ready(ctx), () => wait(), () => [join(root, 'mcp.json')]);
  const skill = (name, config = { [basename(name)]: { command: 'python3', args: ['scripts/server.py'], exposure: 'codemode' } }) => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md'); writeFileSync(path, '---\nname: example\n---\nUse the tools.');
    if (config) writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: config }));
    return path;
  };
  const dispatch = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const read = (path, extra = {}) => dispatch('tool_result', { toolName: 'read', input: { path }, content: [{ type: 'text', text: 'skill body' }], isError: false, ...extra });
  const failures = () => entries.filter(entry => entry.customType === 'piop-skill-mcp-failed').map(entry => entry.data.skill);
  const command = (name, path) => commands.push({ name: `skill:${name}`, source: 'skill', sourceInfo: { path } });
  try { await run({ root, ctx, loader, servers, calls, removed, entries, skill, dispatch, read,
    connection, statuses, failures, command,
    async restart() { await dispatch('session_shutdown'); handlers.clear(); skillMcp(pi, ctx => ready(ctx), () => wait(), () => [join(root, 'mcp.json')]); await dispatch('session_start'); },
    fail(value) { failure = value; }, wait(value) { wait = value; }, ready(value) { ready = value; } }); }
  finally { await dispatch('session_shutdown'); rmSync(root, { recursive: true, force: true }); }
}

test('saved skill MCP configuration restores after a fresh agent starts without rereading the skill', () => fixture(async f => {
  await f.read(f.skill('saved'));
  const original = f.calls[0];
  assert.ok(f.entries.length > 0, 'MCP requirements must be saved in the session');
  rmSync(join(f.root, 'saved'), { recursive: true });
  await f.restart();
  await f.dispatch('input');
  assert.deepEqual([...f.servers], [[original.name, original.config]]);
}));

test('a dropped connection keeps the server for the next call to reconnect', () => fixture(async f => {
  await f.read(f.skill('app')); const name = f.calls[0].name;
  f.connection(name, 'disconnected', 'Process exited with code 1');
  assert.ok(f.servers.has(name)); assert.deepEqual(f.failures(), []);
  assert.equal(await f.dispatch('input', { text: 'continue' }), undefined);
}));

test('a server that fails to connect leaves the chat with a notice, and a new read starts it again', () => fixture(async f => {
  const path = f.skill('app'); await f.read(path); const name = f.calls[0].name;
  f.connection(name, 'failed', 'missing command');
  assert.equal(f.servers.size, 0); assert.equal(f.statuses.get('piop-skill-mcp'), undefined); assert.deepEqual(f.failures(), ['app']);
  assert.equal(await f.dispatch('input', { text: 'continue' }), undefined);
  await f.restart(); await f.dispatch('input'); assert.equal(f.servers.size, 0);
  assert.equal((await f.read(path)).isError, undefined); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].name, name);
}));

test('a restored server that cannot start leaves the chat with a notice and does not block it', () => fixture(async f => {
  await f.read(f.skill('app'));
  f.fail(() => true); await f.restart();
  assert.equal(f.servers.size, 0); assert.deepEqual(f.failures(), ['app']);
  assert.equal(await f.dispatch('input', { text: 'continue' }), undefined);
}));

test('skill reads load adjacent MCP settings with skill and project paths', () => fixture(async f => {
  const path = f.skill('desktop', { desktop: { command: './serve', args: ['${SKILL_DIR}/app.py', '${PROJECT_DIR}'], env: { PROJECT: '${PROJECT_DIR}' }, exposure: 'deferred' } });
  assert.equal(f.calls.length, 0);
  const result = await f.read(path);
  assert.equal(result.content[0].text, 'skill body');
  const { name, config } = f.calls[0];
  assert.equal(config.command, join(f.root, 'desktop/serve'));
  assert.equal(config.cwd, undefined);
  assert.deepEqual(config.args, [join(f.root, 'desktop/app.py'), f.root]);
  assert.equal(config.env.PROJECT, f.root); assert.equal(config.exposure, 'deferred');
  assert.equal(name, 'desktop');
  assert.ok(result.content[1].text.includes(`desktop: mcp__${name}__* (find with tool_search)`));
}));

test('repeat, concurrent and symlink reads share one server per skill', () => fixture(async f => {
  const path = f.skill('one'); const alias = join(f.root, 'alias'); symlinkSync(join(f.root, 'one'), alias);
  let release; const gate = new Promise(resolve => { release = resolve; }); f.ready(() => gate);
  const first = f.read(path), second = f.read(join(alias, 'SKILL.md')); release();
  await Promise.all([first, second]); await f.read('one/SKILL.md');
  assert.equal(f.calls.length, 1);
}));

test('skills with equal server names stay separate and do not start disabled servers', () => fixture(async f => {
  await f.read(f.skill('one')); await f.read(f.skill('two'));
  assert.equal(f.servers.size, 2); assert.notEqual(f.calls[0].name, f.calls[1].name);
  await f.read(f.skill('disabled', { desktop: { command: 'server', enabled: false, exposure: 'direct' } }));
  assert.equal(f.calls.length, 2);
}));

test('a skill server name already used in the chat fails loading without starting servers', () => fixture(async f => {
  f.servers.set('agent', { command: 'agent' });
  const agent = await f.read(f.skill('agent'));
  assert.deepEqual(agent, { content: [{ type: 'text', text: SKILL_MCP_FAILED }], isError: true });
  writeFileSync(join(f.root, 'mcp.json'), JSON.stringify({ mcpServers: { 'my-config': { command: 'configured' } } }));
  assert.equal((await f.read(f.skill('my_config'))).isError, true);
  await f.read(f.skill('first/same'));
  assert.equal((await f.read(f.skill('second/same', { same: { command: 'python3', args: ['other.py'], exposure: 'codemode' } }))).isError, true);
  assert.deepEqual(f.calls.map(call => call.name), ['same']); assert.deepEqual(f.failures(), ['agent', 'my_config', 'same']);
}));

test('skills that start the same server share it, and its failure takes it from each of them', () => fixture(async f => {
  const shared = { app: { command: 'python3', args: ['/opt/app/server.py'], cwd: '/opt/app', exposure: 'direct' } };
  const one = f.skill('one', shared), two = f.skill('two', shared);
  await f.read(one); await f.read(two);
  assert.deepEqual(f.calls.map(call => call.name), ['app']);
  assert.deepEqual(JSON.parse(f.statuses.get('piop-skill-mcp')).map(server => server.label), ['one, two: app']);
  await f.restart(); await f.dispatch('input');
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.statuses.get('piop-skill-mcp')).length, 1);
  const other = await f.read(f.skill('three', { app: { ...shared.app, args: ['/opt/other/server.py'] } }));
  assert.equal(other.isError, true); assert.equal(other.content[0].text, SKILL_MCP_FAILED); assert.equal(f.calls.length, 2);
  f.connection('app', 'failed', 'crashed');
  assert.equal(f.servers.size, 0); assert.equal(f.statuses.get('piop-skill-mcp'), undefined); assert.deepEqual(f.failures(), ['three', 'one', 'two']);
  await f.read(one); await f.read(two); assert.deepEqual(f.calls.map(call => call.name), ['app', 'app', 'app']);
}));

test('ordinary reads, failed reads and skills without MCP settings have no effect', () => fixture(async f => {
  await f.read(join(f.root, 'notes.md'));
  await f.read(f.skill('plain', null));
  await f.read(f.skill('broken-read'), { isError: true });
  await f.read(f.skill('bash'), { toolName: 'bash' });
  assert.equal(f.calls.length, 0);
}));

test('invalid settings fail the read before starting any servers and can be corrected', () => fixture(async f => {
  const path = f.skill('bad', { good: { command: 'server', exposure: 'direct' }, bad: { args: [], exposure: 'direct' } });
  const result = await f.read(path);
  assert.deepEqual(result, { content: [{ type: 'text', text: SKILL_MCP_FAILED }], isError: true });
  assert.equal(f.calls.length, 0); assert.deepEqual(f.failures(), ['bad']);
  f.skill('bad'); await f.read(path); assert.equal(f.calls.length, 1);
}));

test('when one server of a skill cannot start, the read fails and none of its servers stay', () => fixture(async f => {
  const path = f.skill('two', { first: { command: 'one', exposure: 'direct' }, second: { command: 'two', exposure: 'direct' } });
  f.fail(name => name === 'second');
  assert.deepEqual(await f.read(path), { content: [{ type: 'text', text: SKILL_MCP_FAILED }], isError: true });
  assert.equal(f.servers.size, 0); assert.deepEqual(f.failures(), ['two']);
  f.fail(); assert.equal((await f.read(path)).isError, undefined); assert.equal(f.servers.size, 2);
}));

test('a user-invoked skill starts its MCP before the message is sent, and a failure keeps the message unsent', () => fixture(async f => {
  f.command('good', f.skill('good')); f.command('bad', f.skill('bad', { broken: { command: 'server', exposure: 'direct' } }));
  assert.equal(await f.dispatch('input', { text: '/skill:good do it' }), undefined); assert.equal(f.servers.size, 1);
  f.fail(name => name === 'broken');
  assert.deepEqual(await f.dispatch('input', { text: '/skill:bad do it' }), { action: 'handled' });
  assert.deepEqual(JSON.parse(f.statuses.get('piop-input-rejected')), { text: '/skill:bad do it', error: SKILL_MCP_FAILED });
  assert.deepEqual(f.failures(), ['bad']); assert.equal(f.servers.size, 1);
  assert.equal(await f.dispatch('input', { text: '/skill:unknown do it' }), undefined);
}));

test('skill read waits for MCP connection work before returning tool names', () => fixture(async f => {
  let release, finished = false; const gate = new Promise(resolve => { release = resolve; });
  f.wait(() => gate);
  const pending = f.read(f.skill('slow')).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(f.calls.length, 1);
  release(); assert.match((await pending).content.at(-1).text, /Skill MCP tools/);
}));

test('skill settings choose the exposure and codemode servers wait for the Codemode switch', () => fixture(async f => {
  const missing = await f.read(f.skill('missing', { desktop: { command: 'server' } }));
  assert.equal(missing.isError, true); assert.equal(missing.content[0].text, SKILL_MCP_FAILED);
  await f.read(f.skill('direct', { desktop: { command: 'server', exposure: 'direct' } }));
  assert.equal(f.calls[0].config.exposure, 'direct');
  f.loader.select(false);
  const path = f.skill('one'), blocked = await f.read(path);
  assert.equal(blocked.isError, true); assert.equal(blocked.content[0].text, SKILL_MCP_FAILED);
  assert.equal(f.calls.length, 1, 'direct servers stay connected and codemode servers do not start');
  f.loader.select(true); await f.read(path); assert.equal(f.calls.at(-1).config.exposure, 'codemode'); assert.equal(f.servers.size, 2);
  f.loader.select(false); assert.equal(f.servers.size, 1); assert.deepEqual(f.removed, [f.calls.at(-1).name]);
  assert.deepEqual(f.failures(), ['missing', 'one', 'one']);
}));

test('skill servers are removed on session change and shutdown', () => fixture(async f => {
  const path = f.skill('one'); await f.read(path);
  const name = f.calls[0].name;
  await f.dispatch('session_start'); assert.equal(f.servers.size, 1);
  await f.read(path); assert.equal(f.calls.at(-1).name, name);
  await f.dispatch('session_shutdown'); assert.equal(f.servers.size, 0);
}));

test('expanded skill commands load the same servers as reading the skill', () => fixture(async f => {
  const path = f.skill('one');
  const result = await f.dispatch('before_agent_start', { prompt: `<skill name="one" location="${path}">\nbody\n</skill>` });
  assert.match(result.message.content, /Skill MCP tools/);
  await f.read(path); assert.equal(f.calls.length, 1);
}));

test('a prompt with several expanded skills loads the servers of each skill', () => fixture(async f => {
  const one = f.skill('one'), two = f.skill('two');
  const result = await f.dispatch('before_agent_start', { prompt: `<skill name="one" location="${one}">\nbody\n</skill>\n\n<skill name="two" location="${two}">\nbody\n</skill>\n\nrequest` });
  assert.equal(result.message.content.match(/Skill MCP tools/g).length, 2);
  assert.equal(f.calls.length, 2);
}));

test('a session change during startup does not register servers in the new session', () => fixture(async f => {
  let release; const gate = new Promise(resolve => { release = resolve; }); f.ready(() => gate);
  const pending = f.read(f.skill('slow'));
  await f.dispatch('session_start'); release();
  assert.equal((await pending).isError, true); assert.equal(f.servers.size, 1);
}));

test('HTTP servers keep their settings and malformed JSON is reported', () => fixture(async f => {
  await f.read(f.skill('http', { remote: { url: 'https://example.invalid/mcp', headers: { 'X-Project': '${PROJECT_DIR}' }, exposure: 'direct' } }));
  assert.equal(f.calls[0].config.url, 'https://example.invalid/mcp');
  assert.equal(f.calls[0].config.headers['X-Project'], f.root);
  const path = f.skill('invalid'); writeFileSync(join(f.root, 'invalid/mcp.json'), '{');
  assert.equal((await f.read(path)).isError, true); assert.equal(f.calls.length, 1);
}));
