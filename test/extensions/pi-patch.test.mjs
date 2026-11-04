import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchGetter, patchMethod, requireMethods } from '../../daemon/resources/pi-patch.cjs';
import { installAvailability } from '../../daemon/resources/runtime-availability.cjs';
import { installConnectionEvents } from '../../daemon/resources/mcp-connections.cjs';

const missing = (owner, name) => new RegExp(`^Error: Pi has no (method|property) ${owner}\\.${name}, which piop uses\\. Update piop's Pi changes for this Pi version\\.$`);

test('a replaced Pi method keeps the original reachable, and a missing one stops with its class and name', () => {
  class AgentSession { prompt(text) { return 'pi:' + text; } }
  const original = patchMethod(AgentSession.prototype, 'prompt', prompt => function (text) { return 'piop>' + prompt.call(this, text); });
  assert.equal(new AgentSession().prompt('hi'), 'piop>pi:hi');
  assert.equal(original.call(new AgentSession(), 'hi'), 'pi:hi');

  assert.throws(() => patchMethod(AgentSession.prototype, '_queueFollowUp', original => original), missing('AgentSession', '_queueFollowUp'));
  assert.equal(Object.hasOwn(AgentSession.prototype, '_queueFollowUp'), false);
  assert.throws(() => requireMethods(AgentSession, ['open']), missing('AgentSession', 'open'));
});

test('a replaced Pi getter reads the inherited getter, and a plain field is refused', () => {
  class AgentSession { get pendingMessageCount() { return 2; } }
  const session = new AgentSession();
  patchGetter(session, 'pendingMessageCount', count => function () { return count.call(this) + 1; });
  assert.equal(session.pendingMessageCount, 3);
  assert.equal(new AgentSession().pendingMessageCount, 2);

  const changed = new (class AgentSession { constructor() { this.pendingMessageCount = 0; } })();
  assert.throws(() => patchGetter(changed, 'pendingMessageCount', count => count), missing('AgentSession', 'pendingMessageCount'));
});

test('a Pi without a method that piop changes refuses the change and installs nothing', () => {
  class AgentSession {}
  assert.throws(() => installAvailability(AgentSession), missing('AgentSession', '_bindExtensionCore'));
  class McpServerConnection {}
  assert.throws(() => installConnectionEvents(McpServerConnection), missing('McpServerConnection', 'changed'));
  assert.equal(Object.hasOwn(McpServerConnection.prototype, 'changed'), false);
});
