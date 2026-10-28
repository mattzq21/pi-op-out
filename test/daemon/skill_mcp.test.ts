import { expect, test } from 'bun:test';
import { wireCommand } from '../../daemon/src/host/protocol';

test('skill MCP actions are sent to the session extension', () => {
  for (const action of ['retry', 'remove']) {
    const command = { type: 'skill_mcp', name: 'skill_123_app', action };
    expect(wireCommand(command, 'request')).toEqual({ type: 'piop_request', id: 'request', command: 'skill_mcp', payload: { ...command, id: 'request' } });
  }
});
