import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpServers } from '../../extensions/piop-define-agents/mcp-config.ts';

const stdio = { id: 'search', name: 'Search', command: 'search-server' };

const http = { id: 'web', name: 'Web', transport: 'http', url: 'https://example.com/mcp' };

test('agent MCP definitions normalize defaults without modifying the input', () => {
  assert.deepEqual(mcpServers(undefined), []);
  const input = [Object.freeze({ ...stdio }), Object.freeze({ ...http, enabled: false, headers: { Authorization: 'token' }, startupTimeoutSec: 600 })];
  const result = mcpServers(input);
  assert.deepEqual(result, [
    { ...stdio, transport: 'stdio', args: '', enabled: true, url: undefined, headers: undefined, startupTimeoutSec: undefined, injectAgentId: undefined },
    { ...http, command: '', args: '', enabled: false, headers: '{"Authorization":"token"}', startupTimeoutSec: 600, injectAgentId: undefined },
  ]);
  result[0].command = 'changed';
  assert.equal(input[0].command, 'search-server');
  assert.deepEqual(input[1].headers, { Authorization: 'token' });

  for (const headers of [null, '{"Authorization":"token"}']) assert.equal(mcpServers([{ ...stdio, headers }])[0].headers, headers);
});

test('agent MCP limits accept 32 unique definitions and reject invalid identities', () => {
  const full = Array.from({ length: 32 }, (_, index) => ({ ...stdio, id: `server-${index}` }));
  assert.equal(mcpServers(full).length, 32);

  for (const value of [null, {}, 'server', [...full, { ...stdio, id: 'extra' }]]) assert.throws(() => mcpServers(value), /at most 32/);

  for (const item of [null, 'legacy-id', {}, { ...stdio, id: '' }, { ...stdio, id: ' ' }, { ...stdio, id: 1 }]) assert.throws(() => mcpServers([item]), /unique id/);
  const callable = Object.assign(function Search() {}, { id: stdio.id, command: stdio.command });
  assert.throws(() => mcpServers([callable]), /unique id/);
  assert.throws(() => mcpServers([stdio, { ...stdio }]), /unique id/);

  for (const name of ['', ' ', 42, undefined]) assert.throws(() => mcpServers([{ ...stdio, name }]), /name is required/);
});

test('agent MCP options validate enabled flags, timeout boundaries and stdio arguments', () => {
  for (const startupTimeoutSec of [1, 600]) assert.equal(mcpServers([{ ...stdio, startupTimeoutSec }])[0].startupTimeoutSec, startupTimeoutSec);

  for (const startupTimeoutSec of [0, 601, 1.5, '10', null, NaN, Infinity]) assert.throws(() => mcpServers([{ ...stdio, startupTimeoutSec }]), /startup timeout/);

  for (const enabled of [null, 1, 'true']) assert.throws(() => mcpServers([{ ...stdio, enabled }]), /enabled must be a boolean/);

  for (const injectAgentId of [null, 1, 'true', {}]) assert.throws(() => mcpServers([{ ...stdio, injectAgentId }]), /injectAgentId must be a boolean/);

  for (const injectAgentId of [false, true]) assert.equal(mcpServers([{ ...stdio, injectAgentId }])[0].injectAgentId, injectAgentId);

  for (const command of ['', ' ', 1, undefined]) assert.throws(() => mcpServers([{ ...stdio, command }]), /command is required/);

  for (const args of [null, [], 7]) assert.throws(() => mcpServers([{ ...stdio, args }]), /arguments must be a string/);
  assert.throws(() => mcpServers([{ ...stdio, transport: 'websocket' }]), /unsupported MCP transport/);
});

test('agent HTTP MCP definitions validate protocols and both header encodings', () => {
  for (const url of ['http://example.com/mcp', 'https://example.com/mcp']) assert.equal(mcpServers([{ ...http, url }])[0].url, url);

  for (const url of ['', 'not a url']) assert.throws(() => mcpServers([{ ...http, url }]));

  for (const url of ['file:///tmp/mcp', 'ftp://example.com']) assert.throws(() => mcpServers([{ ...http, url }]), { message: 'Web: URL must use HTTP or HTTPS' });

  for (const headers of [undefined, '', '{}', { Authorization: 'secret' }]) assert.equal(mcpServers([{ ...http, headers }]).length, 1);
  assert.throws(() => mcpServers([{ ...http, headers: '{bad' }]), SyntaxError);

  for (const headers of ['null', '[]', '{"x":3}', [], 1, { x: false }]) assert.throws(() => mcpServers([{ ...http, headers }]), { message: 'Web: headers must contain string values' });
});
