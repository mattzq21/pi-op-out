import assert from 'node:assert/strict';
import { test } from 'node:test';
import btwExtension from '../../src-tauri/resources/btw.ts';

async function fixture(run) {
  const statuses = [], notices = [], inputs = [];
  let command, complete, session = '/session.jsonl';
  const done = new Promise(resolve => { complete = resolve; });
  btwExtension({ registerCommand(name, value) { assert.equal(name, 'btw'); command = value; } });
  const ctx = { mode: 'rpc', cwd: '/project space', sessionManager: { getSessionFile: () => session, getLeafId: () => 'leaf' },
    ui: { notify(...args) { notices.push(args); }, async input(...args) { inputs.push(args); }, setStatus(key, value) { statuses.push([key, value]); if (value === undefined) complete(); } } };
  await run({ ctx, statuses, notices, inputs, done, execute: args => command.handler(args, ctx),
    setSession(value) { session = value; } });
}

test('btw validates input and hands desktop side conversations to the UI without launching a child', async () => fixture(async f => {
  await f.execute(' \n '); assert.deepEqual(f.notices.pop(), ['/btw needs a message to send', 'warning']);
  f.setSession(undefined); await f.execute('question'); assert.deepEqual(f.notices.pop(), ['/btw needs a persisted session to branch from', 'error']);
  assert.deepEqual(f.statuses, []);
  f.setSession('/session.jsonl');
  await f.execute(' question λ '); await f.done;
  assert.equal(f.inputs[0][0], '__pi_desktop_btw__');
  assert.deepEqual(JSON.parse(f.inputs[0][1]), { task: 'question λ', sessionFile: '/session.jsonl', leafId: 'leaf', cwd: '/project space' });
  assert.deepEqual(f.statuses, [['btw', 'Running side conversation…'], ['btw', undefined]]);
}));

test('btw reports UI handoff failures and clears its status', async () => fixture(async f => {
  f.ctx.ui.input = async () => { throw new Error('handoff failed'); };
  await f.execute('question'); await f.done;
  assert.deepEqual(f.notices, [['/btw failed: handoff failed', 'error']]);
  assert.deepEqual(f.statuses.at(-1), ['btw', undefined]);
}));
