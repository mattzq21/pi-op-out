import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture, configured, profile } from '../defined-agent-fixture.mjs';

test('stored MCP command arguments preserve quoted words and empty arguments', async t => {
  const f = await agentFixture(t, { config: configured([profile('reviewer', { mcpServers: [
    { id: 'search', name: 'Search', command: 'search-server', args: '--query "two words" \'\' escaped\\ space', injectAgentId: true },
  ] })]) });
  await f.load();

  const configuration = await f.configuration();
  assert.deepEqual(configuration.agents.find(agent => agent.name === 'reviewer').mcpServers, {
    search: { command: 'search-server', args: ['--query', 'two words', '', 'escaped space'], enabled: true, description: 'Search', timeout: 120, piopInjectAgentId: true },
  });
});

test('stored HTTP MCP settings preserve headers and a disabled server', async t => {
  const f = await agentFixture(t, { config: configured([profile('reviewer', { mcpServers: [
    { id: 'web', name: 'Web', transport: 'http', url: 'https://example.com/mcp', headers: '{"Authorization":"fixture"}', enabled: false },
  ] })]) });
  await f.load();

  const configuration = await f.configuration();
  assert.deepEqual(configuration.agents.find(agent => agent.name === 'reviewer').mcpServers, {
    web: { url: 'https://example.com/mcp', headers: { Authorization: 'fixture' }, enabled: false, description: 'Web', timeout: 120 },
  });
});

test('loading stored MCP settings reports an unfinished argument quote', async t => {
  const f = await agentFixture(t, { config: configured([profile('reviewer', { mcpServers: [
    { id: 'search', name: 'Search', command: 'search', args: '"unfinished' },
  ] })]) });
  await assert.rejects(f.load(), /Unterminated quote in legacy MCP arguments/);
});

test('loading stored HTTP MCP settings reports a numeric header value', async t => {
  const f = await agentFixture(t, { config: configured([profile('reviewer', { mcpServers: [
    { id: 'web', name: 'Web', transport: 'http', url: 'https://example.com', headers: '{"x":3}' },
  ] })]) });

  await assert.rejects(f.load(), /headers must contain string values/);
});
