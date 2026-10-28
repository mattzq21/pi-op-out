import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillMcp } from '../../daemon/resources/skill-mcp.ts';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'piop-skill-mcp-'));
  const handlers = new Map(), servers = new Map(), calls = [], removed = [];
  let failure, wait = async () => {}, ready = async () => {};
  const ctx = { cwd: root };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerMcpServer(name, config) {
      if (failure?.(name)) throw new Error('registration failed');
      calls.push({ name, config }); servers.set(name, config);
    },
    unregisterMcpServer(name) { removed.push(name); servers.delete(name); },
  };
  const loader = skillMcp(pi, ctx => ready(ctx), () => wait());
  const skill = (name, config = { desktop: { command: 'python3', args: ['scripts/server.py'] } }) => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md'); writeFileSync(path, '---\nname: example\n---\nUse the tools.');
    if (config) writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: config }));
    return path;
  };
  const dispatch = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const read = (path, extra = {}) => dispatch('tool_result', { toolName: 'read', input: { path }, content: [{ type: 'text', text: 'skill body' }], isError: false, ...extra });
  try { await run({ root, ctx, loader, servers, calls, removed, skill, dispatch, read,
    fail(value) { failure = value; }, wait(value) { wait = value; }, ready(value) { ready = value; } }); }
  finally { await dispatch('session_shutdown'); rmSync(root, { recursive: true, force: true }); }
}

test('skill reads load adjacent MCP settings with skill and project paths', () => fixture(async f => {
  const path = f.skill('desktop', { desktop: { command: './serve', args: ['${SKILL_DIR}/app.py', '${PROJECT_DIR}'], env: { PROJECT: '${PROJECT_DIR}' } } });
  assert.equal(f.calls.length, 0);
  const result = await f.read(path);
  assert.equal(result.content[0].text, 'skill body');
  const { name, config } = f.calls[0];
  assert.equal(config.command, join(f.root, 'desktop/serve'));
  assert.equal(config.cwd, join(f.root, 'desktop'));
  assert.deepEqual(config.args, [join(f.root, 'desktop/app.py'), f.root]);
  assert.equal(config.env.PROJECT, f.root); assert.equal(config.exposure, 'codemode');
  assert.ok(result.content[1].text.includes(`desktop: mcp__${name}__*`));
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
  await f.read(f.skill('disabled', { desktop: { command: 'server', enabled: false } }));
  assert.equal(f.calls.length, 2);
}));

test('ordinary reads, failed reads and skills without MCP settings have no effect', () => fixture(async f => {
  await f.read(join(f.root, 'notes.md'));
  await f.read(f.skill('plain', null));
  await f.read(f.skill('broken-read'), { isError: true });
  await f.read(f.skill('bash'), { toolName: 'bash' });
  assert.equal(f.calls.length, 0);
}));

test('invalid settings report an error before starting any servers and can be corrected', () => fixture(async f => {
  const path = f.skill('bad', { good: { command: 'server' }, bad: { args: [] } });
  const result = await f.read(path); assert.equal(result.isError, true); assert.match(result.content.at(-1).text, /Skill MCP loading failed/);
  assert.equal(f.calls.length, 0);
  f.skill('bad'); await f.read(path); assert.equal(f.calls.length, 1);
}));

test('partial registration failure removes its servers and a later read can retry', () => fixture(async f => {
  const path = f.skill('two', { first: { command: 'one' }, second: { command: 'two' } });
  f.fail(name => name.endsWith('_second'));
  assert.equal((await f.read(path)).isError, true); assert.equal(f.servers.size, 0); assert.equal(f.removed.length, 1);
  f.fail(); await f.read(path); assert.equal(f.servers.size, 2);
}));

test('skill read waits for MCP connection work before returning tool names', () => fixture(async f => {
  let release, finished = false; const gate = new Promise(resolve => { release = resolve; });
  f.wait(() => gate);
  const pending = f.read(f.skill('slow')).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(f.calls.length, 1);
  release(); assert.match((await pending).content.at(-1).text, /Skill MCP tools/);
}));

test('skill servers follow codemode and are removed on session change and shutdown', () => fixture(async f => {
  f.loader.select(false); const path = f.skill('one'); await f.read(path);
  assert.equal(f.calls[0].config.exposure, 'direct');
  f.loader.select(true); assert.equal(f.calls.at(-1).config.exposure, 'codemode');
  const name = f.calls[0].name; assert.equal(f.calls.at(-1).name, name);
  await f.dispatch('session_start'); assert.equal(f.servers.size, 0);
  await f.read(path); assert.notEqual(f.calls.at(-1).name, name);
  await f.dispatch('session_shutdown'); assert.equal(f.servers.size, 0);
}));

test('expanded skill commands load the same servers as reading the skill', () => fixture(async f => {
  const path = f.skill('one');
  const result = await f.dispatch('before_agent_start', { prompt: `<skill name="one" location="${path}">\nbody\n</skill>` });
  assert.match(result.message.content, /Skill MCP tools/);
  await f.read(path); assert.equal(f.calls.length, 1);
}));

test('a session change during startup does not register servers in the new session', () => fixture(async f => {
  let release; const gate = new Promise(resolve => { release = resolve; }); f.ready(() => gate);
  const pending = f.read(f.skill('slow'));
  await f.dispatch('session_start'); release();
  assert.equal((await pending).isError, true); assert.equal(f.servers.size, 0);
}));

test('HTTP servers keep their settings and malformed JSON is reported', () => fixture(async f => {
  await f.read(f.skill('http', { remote: { url: 'https://example.invalid/mcp', headers: { 'X-Project': '${PROJECT_DIR}' } } }));
  assert.equal(f.calls[0].config.url, 'https://example.invalid/mcp');
  assert.equal(f.calls[0].config.headers['X-Project'], f.root);
  const path = f.skill('invalid'); writeFileSync(join(f.root, 'invalid/mcp.json'), '{');
  assert.equal((await f.read(path)).isError, true); assert.equal(f.calls.length, 1);
}));
