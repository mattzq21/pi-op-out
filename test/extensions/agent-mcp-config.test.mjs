import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpServers } from '../../extensions/piop-define-agents/mcp-config.ts';

test('native MCP records preserve options and are independent of their input', () => {
  assert.deepEqual(mcpServers(undefined), {});

  const input = {
    search: { command: 'search-server', args: ['--query', 'two words'], env: { MODE: 'search' }, enabled: false, timeout: 900, exposure: 'deferred', piopInjectAgentId: true },
    web: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'fixture' }, toolExposure: { search: 'hidden' }, oauth: { clientId: 'fixture', callbackPort: 12345, callbackUrl: 'http://127.0.0.1:12345/callback' } },
  };

  const result = mcpServers(input);
  assert.deepEqual(result, input);
  result.search.args.push('changed'); result.search.env.MODE = 'changed'; result.web.headers.Authorization = 'changed';
  assert.deepEqual(input.search.args, ['--query', 'two words']);
  assert.equal(input.search.env.MODE, 'search');
  assert.equal(input.web.headers.Authorization, 'fixture');
});

test('legacy MCP records migrate quoted arguments and HTTP headers to native configurations', () => {
  const result = mcpServers([
    { id: 'search', name: 'Search', command: 'search-server', args: '--query "two words" \'\' escaped\\ space', injectAgentId: true },
    { id: 'web', name: 'Web', transport: 'http', url: 'https://example.com/mcp', headers: '{"Authorization":"fixture"}', enabled: false },
  ]);

  assert.deepEqual(result, {
    search: { command: 'search-server', args: ['--query', 'two words', '', 'escaped space'], enabled: true, description: 'Search', exposure: 'direct', timeout: 120, piopInjectAgentId: true },
    web: { url: 'https://example.com/mcp', headers: { Authorization: 'fixture' }, enabled: false, description: 'Web', exposure: 'direct', timeout: 120 },
  });
  assert.throws(() => mcpServers([{ id: 'search', name: 'Search', command: 'search', args: '"unfinished' }]), /Unterminated quote/);
  assert.throws(() => mcpServers([{ id: 'web', name: 'Web', transport: 'http', url: 'https://example.com', headers: '{"x":3}' }]), /headers must contain string values/);
});

test('MCP identities and transport options reject invalid records without imposing an obsolete count limit', () => {
  assert.equal(Object.keys(mcpServers(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`server_${i}`, { command: 'search' }])))).length, 40);

  for (const value of [null, 'server', { 'bad name': { command: 'search' } }, { 'server-one': { command: 'search' }, server_one: { command: 'search' } }]) assert.throws(() => mcpServers(value));
  assert.throws(() => mcpServers([{ id: 'same', name: 'One', command: 'search' }, { id: 'same', name: 'Two', command: 'search' }]), /duplicate MCP server name/);

  for (const change of [{ command: '' }, { command: ' ' }, { args: '--query' }, { args: [7] }, { env: { MODE: false } }, { enabled: 'true' }, { timeout: 0 }, { timeout: Infinity }, { piopInjectAgentId: 1 }, { type: 'websocket' }, { exposure: 'unknown' }]) assert.throws(() => mcpServers({ search: { command: 'search', ...change } }));
});

test('HTTP MCP and authentication configurations enforce supported protocols and callback consistency', () => {
  for (const url of ['http://example.com/mcp', 'https://example.com/mcp']) assert.equal(mcpServers({ web: { url } }).web.url, url);

  for (const url of ['not a url', 'file:///tmp/mcp', 'ftp://example.com']) assert.throws(() => mcpServers({ web: { url } }));

  for (const headers of ['{}', { x: 3 }, null]) assert.throws(() => mcpServers({ web: { url: 'https://example.com', headers } }));

  for (const oauth of [{ callbackPort: 0 }, { callbackPort: 65536 }, { callbackUrl: 'https://localhost/callback' }, { callbackUrl: 'http://example.com/callback' }, { callbackUrl: 'http://localhost/callback?x=1' }, { callbackUrl: 'http://localhost:1234/callback', callbackPort: 4321 }, { authServerMetadataUrl: 'http://example.com/metadata' }]) assert.throws(() => mcpServers({ web: { url: 'https://example.com', oauth } }));
  assert.throws(() => mcpServers({ web: { url: 'http://example.com', auth: { provider: 'fixture' } } }), /Provider authentication requires HTTPS/);
  assert.equal(mcpServers({ web: { url: 'http://localhost:8080', auth: { provider: 'fixture' } } }).web.auth.provider, 'fixture');
});
