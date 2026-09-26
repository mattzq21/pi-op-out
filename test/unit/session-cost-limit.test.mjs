import assert from 'node:assert/strict';
import { test } from 'node:test';
import costLimit from '../../extensions/piop-session-cost-limit/index.ts';

for (const type of ['compaction', 'usage', 'branch_summary']) test(`session cost limits include ${type} charges`, async () => {
  const handlers = {}; const commands = {}; const entries = [];
  const ctx = { sessionManager: { getBranch: () => entries }, ui: { setStatus() {}, notify() {} } };
  await costLimit({ on: (name, handler) => { handlers[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
  await commands.cost.handler('1', ctx);
  entries.push({ type: 'message', message: { role: 'assistant', usage: { cost: { total: .9 } } } });
  assert.equal(handlers.input({ text: 'Before summarizing' }, ctx), undefined);
  entries.push({ type, usage: { cost: { total: .2 } } });
  assert.deepEqual(handlers.input({ text: 'After summarizing' }, ctx), { action: 'handled' });
  assert.equal(handlers.tool_call({}, ctx).block, true);
});
