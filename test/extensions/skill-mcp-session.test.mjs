import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { skillMcpSession as fixture } from '../skill-mcp-session-fixture.mjs';

const FAILED = "This skill's embedded MCP failed to load";

test('actual agent read, tool use, restore, and a crashed server that the next call starts again', { timeout: 30000 }, async t => {
  const f = await fixture(t); let worker = await f.start();
  let state = await worker.command({ op: 'prompt', mode: 'read' });
  assert.deepEqual(state.errors, []);
  assert.equal(state.toolResults[0]?.isError, false, JSON.stringify(state));
  const name = state.servers[0]; assert.ok(name);
  state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/);
  await worker.kill();
  worker = await f.start(); state = await worker.command({ op: 'prompt', mode: 'ping', text: 'resume' });
  assert.deepEqual(state.errors, []); assert.deepEqual(state.servers, [name]); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/);
  const crashed = Number(readFileSync(f.pid, 'utf8'));
  await worker.command({ op: 'watch', state: 'disconnected' }); process.kill(crashed, 'SIGKILL'); await worker.command({ op: 'watched' });
  state = await worker.command({ op: 'prompt', mode: 'ping', text: 'after crash' });
  assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/); assert.notEqual(Number(readFileSync(f.pid, 'utf8')), crashed);
  assert.deepEqual(state.servers, [name]); assert.deepEqual(state.failures, []);
});
test('user-invoked skill starts MCP in the actual agent', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start();
  const state = await worker.command({ op: 'prompt', text: '/skill:fixture' });
  assert.deepEqual(state.errors, []); assert.equal(state.servers.length, 1); assert.match(state.statuses['piop-skill-mcp'], /connected/);
});

test('a restored server that cannot start leaves the chat with a notice and the next prompt reaches the model', { timeout: 20000 }, async t => {
  const f = await fixture(t); let worker = await f.start();
  await worker.command({ op: 'prompt', mode: 'read' });
  await worker.kill(); writeFileSync(f.blocked, 'blocked'); worker = await f.start();
  const state = await worker.command({ op: 'prompt' });
  assert.equal(state.requests, 1); assert.deepEqual(state.servers, []); assert.deepEqual(state.failures, ['skill']); assert.deepEqual(state.errors, []);
});
test('a startup timeout fails the read with the notice and keeps no server', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start();
  writeFileSync(f.hanging, 'hang');
  const state = await worker.command({ op: 'prompt', mode: 'read' });
  assert.equal(state.toolResults[0].isError, true); assert.deepEqual(state.toolResults[0].result.content, [{ type: 'text', text: FAILED }]);
  assert.deepEqual(state.servers, []); assert.deepEqual(state.failures, ['skill']); assert.equal(state.statuses['piop-skill-mcp'], undefined);
});
test('direct tools remain usable after reload and repeated skill reads keep one server', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start();
  await worker.command({ op: 'codemode', value: 'off' });
  let state = await worker.command({ op: 'prompt', mode: 'read' }); const name = state.servers[0];
  await worker.command({ op: 'prompt', mode: 'read' });
  state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.equal(state.toolResults[0].name, `mcp__${name}__ping`); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/);
  await worker.command({ op: 'reload' });
  state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.deepEqual(state.servers, [name]); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/); assert.deepEqual(state.errors, []);
});

test('when one of two servers cannot start, both leave the chat and stay gone after navigating history', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const path = join(f.skill, 'mcp.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.mcpServers.second = structuredClone(config.mcpServers.fixture); writeFileSync(path, JSON.stringify(config));
  let worker = await f.start();
  const initial = await worker.command({ op: 'prompt', mode: 'read' }); assert.equal(initial.servers.length, 2);
  await worker.kill(); writeFileSync(f.blocked, 'blocked'); worker = await f.start();
  let state = await worker.command({ op: 'prompt', text: 'later' });
  assert.deepEqual(state.servers, []); assert.deepEqual(state.failures, ['skill']);
  rmSync(f.blocked);
  await worker.command({ op: 'branch', leaf: initial.leaf });
  state = await worker.command({ op: 'reload' });
  assert.deepEqual(state.servers, []); assert.deepEqual(state.errors, []);
});
test('requirements are durable even when the agent is killed before MCP startup finishes', { timeout: 20000 }, async t => {
  const f = await fixture(t); let worker = await f.start();
  writeFileSync(f.hanging, 'hang');
  const prompt = worker.command({ op: 'prompt', mode: 'read' });
  const rejected = assert.rejects(prompt, /Worker exited/);
  const status = await worker.event(event => event.key === 'piop-skill-mcp' && event.value?.includes('connecting'));
  const name = JSON.parse(status.value)[0].name;
  await worker.kill(); await rejected; rmSync(f.hanging);
  worker = await f.start();
  const state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.deepEqual(state.servers, [name]); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/); assert.deepEqual(state.errors, []);
});

test('a failed user-invoked skill keeps the message unsent and shows the notice', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start(); writeFileSync(f.blocked, 'blocked');
  const state = await worker.command({ op: 'prompt', text: '/skill:fixture' });
  assert.equal(state.requests, 0); assert.deepEqual(state.errors, []); assert.deepEqual(state.failures, ['skill']);
  assert.deepEqual(JSON.parse(state.statuses['piop-input-rejected']), { text: '/skill:fixture', error: FAILED });
  assert.equal(state.entries.some(entry => entry.type === 'message'), false);
});
test('HTTP MCP restores, and a failed connection leaves the chat with a notice until the skill is read again', { timeout: 20000 }, async t => {
  let unavailable = false;
  const server = createServer(async (req, res) => {
    if (unavailable) { res.writeHead(503); res.end('fixture unavailable'); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'HTTP_PROVEN_PONG' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const f = await fixture(t);
  writeFileSync(join(f.skill, 'mcp.json'), JSON.stringify({ mcpServers: { http: { url: `http://127.0.0.1:${server.address().port}/mcp`, timeout: 1, exposure: 'direct' } } }));
  let worker = await f.start(); await worker.command({ op: 'prompt', mode: 'read' });
  let state = await worker.command({ op: 'prompt', mode: 'ping' }); assert.match(JSON.stringify(state.toolResults), /HTTP_PROVEN_PONG/);
  await worker.kill(); unavailable = true; worker = await f.start();
  state = await worker.command({ op: 'prompt', text: 'continue' }); assert.equal(state.requests, 1); assert.deepEqual(state.servers, []); assert.deepEqual(state.failures, ['skill']);
  unavailable = false; await worker.command({ op: 'prompt', mode: 'read' });
  state = await worker.command({ op: 'prompt', mode: 'ping' }); assert.match(JSON.stringify(state.toolResults), /HTTP_PROVEN_PONG/); assert.deepEqual(state.errors, []);
});
test('ten consecutive agent kills restore the same server and working tools', { timeout: 30000 }, async t => {
  const f = await fixture(t); let worker = await f.start();
  const initial = await worker.command({ op: 'prompt', mode: 'read' }); const name = initial.servers[0];
  for (let cycle = 1; cycle <= 10; cycle++) {
    await worker.kill(); worker = await f.start();
    const state = await worker.command({ op: 'prompt', mode: 'ping', text: `resume ${cycle}` });
    assert.deepEqual(state.servers, [name], `cycle ${cycle}`);
    assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/, `cycle ${cycle}`);
    assert.deepEqual(state.errors, [], `cycle ${cycle}`);
  }
});
