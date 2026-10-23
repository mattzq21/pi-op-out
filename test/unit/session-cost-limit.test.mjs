import assert from 'node:assert/strict';
import { test } from 'node:test';
import costLimitExtension from '../../daemon/plugins/cost/index.ts';
import hooksExtended from '../../daemon/resources/hooks-extended/index.ts';

function costLimit(pi) {
  const listeners = new Map();
  pi.events = {
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    emit(name, value) { listeners.get(name)?.(value); },
  };
  hooksExtended(pi);
  return costLimitExtension(pi);
}

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

async function fixture(entries = []) {
  const handlers = {}, commands = {}, statuses = new Map(), notices = [];
  let aborts = 0;
  const ctx = {
    sessionManager: { getBranch: () => entries },
    ui: { setStatus: (key, value) => statuses.set(key, value), notify: (...args) => notices.push(args) },
    abort: () => { aborts++; },
  };
  await costLimit({
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  });
  return { entries, handlers, ctx, statuses, notices, get aborts() { return aborts; }, set: args => commands.cost.handler(args, ctx) };
}
const charge = (total, role = 'assistant') => ({ type: 'message', message: { role, usage: { cost: { total } } } });
const saved = limit => ({ type: 'custom', customType: 'piop-session-cost-limit', data: { limit } });

test('new sessions have no limit; set, raise, and clear take effect immediately', async () => {
  const f = await fixture([charge(1)]);
  f.handlers.session_start({}, f.ctx);
  assert.equal(f.handlers.input({ text: 'go' }, f.ctx), undefined);
  await f.set('$1');
  assert.deepEqual(f.handlers.input({ text: 'go' }, f.ctx), { action: 'handled' });
  assert.deepEqual(JSON.parse(f.statuses.get('piop-input-rejected')).text, 'go');
  f.handlers.turn_start({}, f.ctx);
  assert.equal(f.aborts, 1);
  assert.equal(f.handlers.tool_call({}, f.ctx).terminate, true);
  await f.set('2');
  assert.equal(f.handlers.input({ text: 'go' }, f.ctx), undefined);
  await f.set('CLEAR');
  assert.equal(f.statuses.get('piop-session-cost'), undefined);
  assert.equal(f.handlers.tool_call({}, f.ctx), undefined);
  assert.equal(f.entries.at(-1).data.limit, null);
});

test('limits restore from the selected branch and clear on a new session', async () => {
  const f = await fixture([saved(1), charge(1)]);
  f.handlers.session_start({}, f.ctx);
  assert.equal(f.handlers.input({ text: 'go' }, f.ctx).action, 'handled');
  f.entries.push(saved(null));
  f.handlers.session_tree({}, f.ctx);
  assert.equal(f.handlers.input({ text: 'go' }, f.ctx), undefined);
  f.entries.splice(0, f.entries.length, saved(2), charge(1));
  f.handlers.session_tree({}, f.ctx);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session $1.00 / $2.00');
  f.entries.splice(0);
  f.handlers.session_start({}, f.ctx);
  assert.equal(f.statuses.get('piop-session-cost'), undefined);
});

test('invalid amounts leave the saved limit unchanged', async () => {
  const f = await fixture();
  await f.set('1');
  for (const value of ['', '0', '-1', '0.001', '100001', 'NaN', 'Infinity', 'abc']) {
    await f.set(value);
    assert.equal(f.entries.length, 1, value);
    assert.equal(f.notices.at(-1)[1], 'error', value);
  }
  for (const value of ['0.01', '.50', '$1,234.56', '$100,000']) {
    await f.set(value);
    assert.equal(f.notices.at(-1)[1], 'info');
  }
});

test('cache warming stops when its estimated charge exceeds the remaining limit', async () => {
  const f = await fixture([charge(0.75)]);
  await f.set('1');
  for (const warmCost of [0, 0.1, 0.25]) assert.equal(f.handlers.cache_warming_decision({ warmCost }, f.ctx), undefined);
  for (const warmCost of [0.26, Infinity, NaN]) assert.deepEqual(f.handlers.cache_warming_decision({ warmCost }, f.ctx), { action: 'stop' });
  f.entries.push(charge(0.25, 'toolResult'));
  assert.deepEqual(f.handlers.cache_warming_decision({ warmCost: 0 }, f.ctx), { action: 'stop' });
});

test('completed responses update the status before session persistence', async () => {
  const f = await fixture([charge(0.75)]);
  await f.set('1');
  const response = charge(0.25);
  f.handlers.message_end({ message: response.message }, f.ctx);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
  f.entries.push(response);
  f.handlers.agent_end({}, f.ctx);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
});

test('summary requests are cancelled at the limit, but free navigation remains available', async () => {
  const f = await fixture([charge(1)]);
  await f.set('1');
  assert.deepEqual(f.handlers.session_before_compact?.({}, f.ctx), { cancel: true });
  assert.deepEqual(f.handlers.session_before_tree?.({ preparation: { userWantsSummary: true } }, f.ctx), { cancel: true });
  assert.equal(f.handlers.session_before_tree?.({ preparation: { userWantsSummary: false } }, f.ctx), undefined);
  await f.set('2');
  assert.equal(f.handlers.session_before_compact({}, f.ctx), undefined);
  assert.equal(f.handlers.session_before_tree({ preparation: { userWantsSummary: true } }, f.ctx), undefined);
});

test('completed compaction publishes its charge immediately', async () => {
  const f = await fixture([charge(0.75)]);
  await f.set('1');
  f.entries.push({ type: 'compaction', usage: { cost: { total: 0.25 } } });
  f.handlers.session_compact?.({}, f.ctx);
  assert.equal(f.statuses.get('piop-session-cost'), 'Session cost limit reached ($1.00 / $1.00)');
});

test('malformed currency amounts cannot silently change the limit', async () => {
  const f = await fixture();
  await f.set('1');
  for (const value of ['1,5', '1,,000', ',10', '10,', '0x10', '0b10']) {
    await f.set(value);
    assert.equal(f.entries.length, 1, value);
    assert.equal(f.notices.at(-1)[1], 'error', value);
  }
});

for (const [costs, limit] of [[Array(10).fill(0.1), 1], [[0.1, 0.7], 0.8], [Array(200).fill(0.005), 1]]) test(`decimal charges stop work at the exact limit (${costs.length} charges, $${limit})`, async () => {
  const f = await fixture(costs.map(cost => charge(cost)));
  await f.set(String(limit));
  assert.deepEqual(f.handlers.input({ text: 'go' }, f.ctx), { action: 'handled' });
  assert.equal(f.handlers.tool_call({}, f.ctx).terminate, true);
  assert.equal(f.statuses.get('piop-session-cost'), `Session cost limit reached ($${limit.toFixed(2)} / $${limit.toFixed(2)})`);
});

test('a real remainder below one cent still permits work', async () => {
  const f = await fixture([charge(0.999999)]);
  await f.set('1');
  assert.equal(f.handlers.input({ text: 'go' }, f.ctx), undefined);
  assert.equal(f.handlers.tool_call({}, f.ctx), undefined);
  f.handlers.turn_start({}, f.ctx);
  assert.equal(f.aborts, 0);
});

test('cache warming can use the exact decimal remainder', async () => {
  const f = await fixture([charge(0.1)]);
  await f.set('0.3');
  assert.equal(f.handlers.cache_warming_decision({ warmCost: 0.2 }, f.ctx), undefined);
  assert.deepEqual(f.handlers.cache_warming_decision({ warmCost: 0.200001 }, f.ctx), { action: 'stop' });
});
