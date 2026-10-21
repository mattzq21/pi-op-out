import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture, profile } from '../defined-agent-fixture.mjs';

test('agent configuration preserves stdio MCP launch options', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure({ agents: [profile('reviewer', { mcpServers: {
    search: { command: 'search-server', args: ['--query', 'two words'], env: { MODE: 'search' }, enabled: false, timeout: 900, piopInjectAgentId: true },
  } })] });
  const saved = await f.configuration();
  assert.deepEqual(saved.agents.find(agent => agent.name === 'reviewer').mcpServers, {
    search: { command: 'search-server', args: ['--query', 'two words'], env: { MODE: 'search' }, enabled: false, timeout: 900, piopInjectAgentId: true },
  });
});

test('agent configuration preserves HTTP MCP authentication options', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure({ agents: [profile('reviewer', { mcpServers: {
    web: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'fixture' }, oauth: { clientId: 'fixture', callbackPort: 12345, callbackUrl: 'http://127.0.0.1:12345/callback' } },
  } })] });
  assert.deepEqual((await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers, {
    web: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'fixture' }, oauth: { clientId: 'fixture', callbackPort: 12345, callbackUrl: 'http://127.0.0.1:12345/callback' } },
  });
});

test('editing a caller configuration after saving does not change saved MCP options', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const servers = {
    search: { command: 'search-server', args: ['--query', 'two words'], env: { MODE: 'search' } },
    web: { url: 'https://example.com/mcp', headers: { Authorization: 'fixture' } },
  };
  await f.configure({ agents: [profile('reviewer', { mcpServers: servers })] });
  servers.search.args.push('changed'); servers.search.env.MODE = 'changed'; servers.web.headers.Authorization = 'changed';
  const saved = (await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers;
  assert.deepEqual(saved.search.args, ['--query', 'two words']);
  assert.equal(saved.search.env.MODE, 'search');
  assert.equal(saved.web.headers.Authorization, 'fixture');
});

test('saving an agent without the required MCP map is rejected without changing settings', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  const agent = profile('reviewer'); delete agent.mcpServers;
  await assert.rejects(f.configure({ agents: [agent] }), /Invalid agent configuration:.*required properties mcpServers/);
  assert.deepEqual(await f.configuration(), before);
});

test('saving an empty MCP map removes the configured servers', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure({ agents: [profile('reviewer', { mcpServers: { search: { command: 'search-server' } } })] });
  await f.configure({ agents: [profile('reviewer', { mcpServers: {} })] });
  assert.deepEqual((await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers, {});
});

test('MCP configuration rejects an empty process command without changing saved agents', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { search: { command: '' } } })] }), /Transport requires a command for stdio or a URL for HTTP/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a whitespace process command without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": " "}} })] }), /Transport requires/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects arguments supplied as text without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "args": "--query"}} })] }), /args/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a numeric process argument without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "args": [7]}} })] }), /args/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a boolean environment value without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "env": {"MODE": false}}} })] }), /env/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a text enabled flag without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "enabled": "true"}} })] }), /enabled/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a zero timeout without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "timeout": 0}} })] }), /timeout/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a numeric agent ID flag without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "piopInjectAgentId": 1}} })] }), /piopInjectAgentId/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects an unsupported transport without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "type": "websocket"}} })] }), /type/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects an unknown exposure without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"search": {"command": "search", "exposure": "unknown"}} })] }), /exposure/);
  assert.deepEqual(await f.configuration(), before);
});

test('MCP configuration preserves all forty named servers', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const servers = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`server_${index}`, { command: `search-${index}` }]));
  await f.configure({ agents: [profile('reviewer', { mcpServers: servers })] });
  const saved = (await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers;
  assert.equal(Object.keys(saved).length, 40);
  for (let index = 0; index < 40; index++) assert.equal(saved[`server_${index}`].command, `search-${index}`);
});

test("MCP configuration rejects a null server map without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: null })] }), /Invalid agent configuration:.*mcpServers/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a text server map without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: "server" })] }), /Invalid agent configuration:.*mcpServers/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a name containing spaces without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"bad name": {"command": "search"}} })] }), /Use letters, digits, underscores or hyphens/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects names differing only by separators without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: {"server-one": {"command": "search"}, "server_one": {"command": "search"}} })] }), /must not differ only by hyphens and underscores/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a legacy array with duplicate names without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: [{"id": "same", "name": "One", "command": "search"}, {"id": "same", "name": "Two", "command": "search"}] })] }), /Invalid agent configuration:.*mcpServers/);
  assert.deepEqual(await f.configuration(), before);
});

test('MCP configuration rejects a nonfinite timeout without changing saved agents', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { search: { command: 'search', timeout: Infinity } } })] }), /timeout/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration saves an HTTP endpoint", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "http://example.com/mcp"} } })] });
  assert.deepEqual((await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers.web, {"url": "http://example.com/mcp"});
});

test("MCP configuration saves an HTTPS endpoint", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com/mcp"} } })] });
  assert.deepEqual((await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers.web, {"url": "https://example.com/mcp"});
});

test("MCP configuration saves provider authentication on loopback HTTP", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "http://localhost:8080", "auth": {"provider": "fixture"}} } })] });
  assert.deepEqual((await f.configuration()).agents.find(agent => agent.name === 'reviewer').mcpServers.web, {"url": "http://localhost:8080", "auth": {"provider": "fixture"}});
});

test("MCP configuration rejects an invalid endpoint without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "not a url"} } })] }), /Expected an HTTP or HTTPS URL/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a file endpoint without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "file:///tmp/mcp"} } })] }), /Expected an HTTP or HTTPS URL/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects an FTP endpoint without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "ftp://example.com"} } })] }), /Expected an HTTP or HTTPS URL/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects text headers without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "headers": "{}"} } })] }), /"headers"[\s\S]*expected record, received string/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects numeric headers without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "headers": {"x": 3}} } })] }), /"headers"[\s\S]*expected string, received number/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects null headers without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "headers": null} } })] }), /"headers"[\s\S]*expected record, received null/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects callback port zero without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"callbackPort": 0}} } })] }), /callbackPort/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects callback port above 65535 without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"callbackPort": 65536}} } })] }), /callbackPort/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects an HTTPS callback without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"callbackUrl": "https://localhost/callback"}} } })] }), /Callback URL must use HTTP on a loopback host/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a remote callback host without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"callbackUrl": "http://example.com/callback"}} } })] }), /Callback URL must use HTTP on a loopback host/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects a callback query string without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"callbackUrl": "http://localhost/callback?x=1"}} } })] }), /Callback URL must use HTTP on a loopback host/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects conflicting callback ports without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"callbackUrl": "http://localhost:1234/callback", "callbackPort": 4321}} } })] }), /Callback URL and port must agree/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects remote HTTP metadata without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "https://example.com", "oauth": {"authServerMetadataUrl": "http://example.com/metadata"}} } })] }), /Metadata URL must use HTTPS or HTTP on a loopback host/);
  assert.deepEqual(await f.configuration(), before);
});

test("MCP configuration rejects provider authentication on remote HTTP without changing saved agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { mcpServers: { web: {"url": "http://example.com", "auth": {"provider": "fixture"}} } })] }), /Provider authentication requires HTTPS/);
  assert.deepEqual(await f.configuration(), before);
});
