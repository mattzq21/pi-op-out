import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { skillMcpSession as fixture } from '../skill-mcp-session-fixture.mjs';

test('actual agent read, tool use, SIGKILL, persisted restore, failure and UI actions', { timeout: 30000 }, async t => {
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
  const requests = state.requests;
  process.kill(Number(readFileSync(f.pid,'utf8')), 'SIGKILL');
  await worker.event(event => event.key === 'piop-skill-mcp' && event.value?.includes('"failed"'));
  state = await worker.command({ op: 'prompt', text: 'must not reach model' }); assert.equal(state.requests, requests);
  writeFileSync(f.blocked, 'blocked'); await assert.rejects(worker.command({ op: 'action', name, action: 'retry' }), /fixture cannot start/);
  rmSync(f.blocked); await worker.command({ op: 'action', name, action: 'retry' });
  state = await worker.command({ op: 'prompt', mode: 'ping' }); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/);
  await worker.command({ op: 'action', name, action: 'remove' }); await worker.kill();
  worker = await f.start(); state = await worker.command({ op: 'prompt' }); assert.deepEqual(state.servers, []); assert.deepEqual(state.errors, []);
});

test('user-invoked skill starts MCP in the actual agent', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start();
  const state = await worker.command({ op: 'prompt', text: '/skill:fixture' });
  assert.deepEqual(state.errors, []); assert.equal(state.servers.length, 1); assert.match(state.statuses['piop-skill-mcp'], /connected/);
});

test('restored startup failure blocks model requests and removing it permits the next prompt', { timeout: 20000 }, async t => {
  const f = await fixture(t); let worker = await f.start();
  const initial = await worker.command({ op: 'prompt', mode: 'read' }); const name = initial.servers[0];
  await worker.kill(); writeFileSync(f.blocked, 'blocked'); worker = await f.start();
  const state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.equal(state.requests, 0); assert.match(state.statuses['piop-skill-mcp'], /fixture cannot start/);
  assert.deepEqual(state.errors, []);
  await worker.command({ op: 'action', name, action: 'remove' });
  assert.equal((await worker.command({ op: 'prompt' })).requests, 1);
});

test('startup timeout is visible and Remove interrupts an in-progress retry', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start();
  writeFileSync(f.hanging, 'hang');
  let state = await worker.command({ op: 'prompt', mode: 'read' }); const name = state.servers[0];
  assert.match(state.statuses['piop-skill-mcp'], /failed/); assert.match(state.statuses['piop-skill-mcp'], /timed out|timeout/i);
  const before = worker.eventCount;
  const retry = worker.command({ op: 'action', name, action: 'retry' });
  await worker.event(event => event.key === 'piop-skill-mcp' && event.value?.includes('connecting'), before);
  await worker.command({ op: 'action', name, action: 'remove' }); await retry;
  state = await worker.command({ op: 'prompt' }); assert.equal(state.statuses['piop-skill-mcp'], undefined); assert.deepEqual(state.servers, []);
});

test('a message enters the queue while a skill MCP server is still connecting', { timeout: 20000 }, async t => {
  const f = await fixture(t), path = join(f.skill, 'mcp.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.mcpServers.fixture.timeout = 10; writeFileSync(path, JSON.stringify(config));
  const worker = await f.start(); writeFileSync(f.slow, 'slow');
  const turn = worker.command({ op: 'prompt', mode: 'read' });
  await worker.event(event => event.key === 'piop-skill-mcp' && event.value?.includes('connecting'));
  const queued = await worker.command({ op: 'queue', text: 'queued while connecting' });
  assert.equal(queued.streaming, true); assert.deepEqual(queued.followUps, ['queued while connecting']);
  assert.match(queued.statuses['piop-skill-mcp'], /connecting/);
  rmSync(f.slow);
  const state = await turn;
  assert.deepEqual(state.errors, []); assert.equal(state.toolResults[0]?.isError, false, JSON.stringify(state));
  assert.match(state.statuses['piop-skill-mcp'], /connected/); assert.deepEqual(state.followUps, []); assert.equal(state.requests, 3);
});

test('direct tools remain usable after reload and repeated skill reads keep one server', { timeout: 20000 }, async t => {
  const f = await fixture(t), path = join(f.skill, 'mcp.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.mcpServers.fixture.exposure = 'direct'; writeFileSync(path, JSON.stringify(config));
  const worker = await f.start();
  await worker.command({ op: 'codemode', value: 'off' });
  let state = await worker.command({ op: 'prompt', mode: 'read' }); const name = state.servers[0];
  await worker.command({ op: 'prompt', mode: 'read' });
  state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.equal(state.toolResults[0].name, `mcp__${name}__ping`); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/);
  await worker.command({ op: 'reload' });
  state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.deepEqual(state.servers, [name]); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/); assert.deepEqual(state.errors, []);
});

test('removing one server preserves another and remains removed after navigating history', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const path = join(f.skill, 'mcp.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.mcpServers.second = structuredClone(config.mcpServers.fixture); writeFileSync(path, JSON.stringify(config));
  const worker = await f.start();
  const initial = await worker.command({ op: 'prompt', mode: 'read' }); assert.equal(initial.servers.length, 2);
  const name = initial.servers[0];
  await worker.command({ op: 'prompt', text: 'later' });
  await worker.command({ op: 'action', name, action: 'remove' });
  await worker.command({ op: 'branch', leaf: initial.leaf });
  await worker.command({ op: 'reload' });
  const state = await worker.command({ op: 'prompt', mode: 'ping' });
  assert.deepEqual(state.servers, initial.servers.slice(1)); assert.match(JSON.stringify(state.toolResults), /PROVEN_PONG/); assert.deepEqual(state.errors, []);
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

test('failed user-only skill invocation does not make a model request', { timeout: 20000 }, async t => {
  const f = await fixture(t), worker = await f.start(); writeFileSync(f.blocked, 'blocked');
  const state = await worker.command({ op: 'prompt', text: '/skill:fixture' });
  assert.equal(state.requests, 0); assert.match(state.statuses['piop-skill-mcp'], /fixture cannot start/); assert.deepEqual(state.errors, []);
});

test('HTTP MCP restores, blocks on failed connection, and reconnects through Retry', { timeout: 20000 }, async t => {
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
  writeFileSync(join(f.skill, 'mcp.json'), JSON.stringify({ mcpServers: { http: { url: `http://127.0.0.1:${server.address().port}/mcp`, timeout: 1, exposure: 'codemode' } } }));
  let worker = await f.start(); await worker.command({ op: 'prompt', mode: 'read' });
  let state = await worker.command({ op: 'prompt', mode: 'ping' }); assert.match(JSON.stringify(state.toolResults), /HTTP_PROVEN_PONG/);
  const name = state.servers[0]; await worker.kill(); unavailable = true; worker = await f.start();
  state = await worker.command({ op: 'prompt', mode: 'ping' }); assert.equal(state.requests, 0); assert.match(state.statuses['piop-skill-mcp'], /failed/);
  unavailable = false; await worker.command({ op: 'action', name, action: 'retry' });
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
