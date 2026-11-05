import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { installConnectionEvents, subscribeConnections } from '../../daemon/resources/mcp/connections.ts';
import { testPi } from '../pi-install.mjs';

const { root } = await testPi();
const { McpServerConnection } = await import(pathToFileURL(join(root, 'dist/extensions/mcp/runtime.js')));
installConnectionEvents(McpServerConnection);

test('real MCP process restores, keeps a crashed server for the next call, and leaves the chat when it cannot start', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piop-skill-runtime-'));
  let session;
  try {
    const shim = join(dir, 'sdk.mjs');
    writeFileSync(shim, `import { createMcpExtension as native } from ${JSON.stringify(pathToFileURL(join(root, 'dist/index.js')).href)}; export const CONFIG_DIR_NAME = '.pi'; export const getAgentDir = () => ${JSON.stringify(join(dir, 'agent'))}; export const createMcpExtension = () => native({loadConfig: () => ({servers: [], errors: []}), logPath: ${JSON.stringify(join(dir, 'mcp.log'))}});`);
    const bundle = join(dir, 'bridge.mjs');
    await build({ entryPoints: ['daemon/resources/mcp/extension.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'sdk', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: shim, external: true }));
    } }] });
    const { default: bridge } = await import(pathToFileURL(bundle));
    const script = join(dir, 'server.mjs'), pid = join(dir, 'pid'), blocked = join(dir, 'blocked');
    writeFileSync(script, `import {createInterface} from 'node:readline'; import {writeFileSync,existsSync} from 'node:fs';
if(existsSync(process.argv[3])) { console.error('test server blocked'); process.exit(1); }
writeFileSync(process.argv[2], String(process.pid));
createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'ping',description:'Ping',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'pong'}]};
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); });`);
    const skill = join(dir, 'SKILL.md'); writeFileSync(skill, 'Use the server.');
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { app: { command: process.execPath, args: [script, pid, blocked], timeout: 2, exposure: 'codemode' } } }));
    const history = join(dir, 'history.json'); writeFileSync(history, '[]');
    const start = async () => {
      const bus = new EventEmitter(), handlers = new Map(), servers = new Map(), tools = new Map(), statuses = new Map();
      let active = ['codemode'];
      tools.set('codemode', { name: 'codemode', reachesTools: true });
      const entries = JSON.parse(readFileSync(history, 'utf8'));
      const ctx = { cwd: dir, mode: 'rpc', sessionManager: { getBranch: () => entries, getSessionId: () => 'session' }, ui: { setStatus: (key, value) => statuses.set(key, value), notify() {} }, abort() {}, isProjectTrusted: () => false };
      const dispatch = async (name, event = {}) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result; return result; };
      const pi = {
        on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
        events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); } },
        appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); writeFileSync(history, JSON.stringify(entries)); },
        getMcpServers: () => [...servers].map(([name, config]) => ({ name, config, extensionPath: bundle })),
        registerMcpServer(name, config) { servers.set(name, config); void dispatch('mcp_servers_change'); },
        unregisterMcpServer(name) { servers.delete(name); void dispatch('mcp_servers_change'); },
        registerTool(tool) { tools.set(tool.name, tool); }, registerToolRenderer() {}, registerCommand() {}, getCommands: () => [],
        getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: value => { active = value; },
      };
      bridge(pi); await dispatch('session_start', { type: 'session_start', reason: 'startup' });
      const failures = () => entries.filter(entry => entry.customType === 'piop-skill-mcp-failed').map(entry => entry.data.skill);
      return { dispatch, statuses, servers, tools, failures };
    };
    session = await start(); await session.dispatch('input', { text: 'start' });
    const result = await session.dispatch('tool_result', { toolName: 'read', input: { path: skill }, content: [], isError: false });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const name = [...session.servers.keys()][0];
    assert.ok(session.tools.has(`mcp__${name}__ping`));
    const crashed = new Promise(resolve => { const stop = subscribeConnections(connection => { if (connection.name === name && connection.state === 'disconnected') { stop(); resolve(); } }); });
    process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL'); await crashed;
    assert.ok(session.servers.has(name)); assert.deepEqual(session.failures(), []);
    assert.equal(await session.dispatch('input', { text: 'continue' }), undefined, session.statuses.get('piop-input-rejected'));
    assert.equal(await session.dispatch('input', { text: 'queued', streamingBehavior: 'followUp' }), undefined);
    await session.dispatch('session_shutdown'); session = await start(); await session.dispatch('input', { text: 'resume' });
    assert.equal(JSON.parse(session.statuses.get('piop-skill-mcp'))[0].name, name);
    assert.equal(JSON.parse(session.statuses.get('piop-skill-mcp'))[0].state, 'connected');
    await session.dispatch('session_shutdown'); writeFileSync(blocked, 'blocked');
    session = await start(); const rejected = await session.dispatch('input', { text: 'resume' });
    assert.equal(rejected, undefined, session.statuses.get('piop-input-rejected'));
    assert.equal(session.servers.size, 0); assert.equal(session.statuses.get('piop-skill-mcp'), undefined);
    assert.deepEqual(session.failures(), [basename(dir)]);
  } finally { await session?.dispatch('session_shutdown'); rmSync(dir, { recursive: true, force: true }); }
});
