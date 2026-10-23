import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture, profile, configured } from '../defined-agent-fixture.mjs';

test('session tools migrate once and later per-agent exclusions survive reload', async t => {
  const config = configured([profile('general', { tools: [] })]); config.sessionToolsDefaultApplied = false;
  const f = await agentFixture(t, { config, tools: ['spawn_subagents'], runtime: { enabledTools: ['spawn_subagents'] } });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['spawn_subagents']);
  await f.configure({ agents: [profile('general', { tools: [] })] });
  await f.reloadExtensions(); await f.select('general');
  assert.deepEqual((await f.configuration()).agents[0].tools, []);
  assert.deepEqual(f.pi.getActiveTools(), []);
});

test('selected agent definitions stay visible through reload and pending MCP startup', async t => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await agentFixture(t, {
    config: null,
    realMcp: { deferToolsUntilStart: true, start: async () => { started.resolve(); await gate.promise; }, servers: {
      'cua-vm': [{ name: 'mcp_cua_vm_example', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'Ready' }] }) }],
    } },
  });
  const published = [];
  const setStatus = f.ctx.ui.setStatus;
  f.ctx.ui.setStatus = (name, value) => { if (name === 'pi-define-agents') published.push(value); setStatus(name, value); };
  f.ctx.reload = f.reloadExtensions;
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { tools: [] }), profile('tester', { tools: [], skills: ['/fixture/skill'], mcpServers: { 'cua-vm': { command: 'cua', args: [], enabled: true } } })]));
  published.length = 0;
  await f.select('tester');
  assert.ok(published.length > 0);
  assert.ok(published.every(Boolean));
  assert.equal(f.capability().active, 'tester');
  assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['general', 'tester']);
  let settled = false;
  const input = f.input('Check the app').finally(() => { settled = true; });
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(f.pi.getActiveTools(), []);
    assert.equal(f.capability().active, 'tester');
  } finally { gate.resolve(); }
  assert.deepEqual(await input, { action: 'continue' });
  assert.deepEqual(f.pi.getActiveTools(), ['mcp_cua_vm_example']);
  assert.deepEqual(await f.tools.get('mcp_cua_vm_example').execute(), { content: [{ type: 'text', text: 'Ready' }] });
});

test('ending an agent session clears its published definitions', async t => {
  const f = await agentFixture(t, { config: null, realMcp: {} });
  await f.load(); await f.start();
  assert.equal(f.capability().active, 'general');
  await f.emit('session_shutdown');
  assert.equal(f.statuses.get('pi-define-agents'), undefined);
});

test('explicit tool exclusions survive tools becoming available after the settings save', async t => {
  const config = configured([profile()]);
  config.sessionToolsDefaultApplied = false;
  config.subagentsDefaultApplied = false;
  config.webSearchDefaultApplied = false;
  const runtime = { enabledTools: ['read'] };
  const f = await agentFixture(t, { config, runtime, tools: ['read', 'subagent', 'web_search'] });
  await f.load(); await f.start();
  await f.configure({ agents: [profile()] });
  runtime.enabledTools.push('subagent', 'web_search');
  await f.reloadExtensions(); await f.select('general');
  assert.deepEqual((await f.configuration()).agents[0].tools, ['read']);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});
