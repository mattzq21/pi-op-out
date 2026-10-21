import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture, profile, configured } from '../defined-agent-fixture.mjs';

const MODE = Symbol.for('piop.codemode-mode');

function recordModes(t) {
  const modes = [];
  Object.defineProperty(globalThis, MODE, { value: mode => modes.push(mode), writable: true, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, MODE); });
  return modes;
}

test('codemode on gives the agent only codemode, and codemode off gives it every tool directly', async t => {
  const modes = recordModes(t);
  const f = await agentFixture(t, { tools: ['read', 'bash', 'codemode'], config: configured([profile('general', { tools: ['read', 'bash'] })]) });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools().toSorted(), ['bash', 'codemode', 'read']);
  assert.equal(modes.at(-1), 'only');

  const off = await agentFixture(t, { tools: ['read', 'bash', 'codemode'], config: configured([profile('general', { tools: ['read', 'bash'], codemode: false })]) });
  await off.load(); await off.start();
  assert.deepEqual(off.pi.getActiveTools().toSorted(), ['bash', 'read']);
  assert.equal(modes.at(-1), 'on');
});

test('an agent cannot start when Piop cannot set how codemode presents the tools', async t => {
  Reflect.deleteProperty(globalThis, MODE);
  const f = await agentFixture(t, { tools: ['read', 'codemode'], config: configured([profile()]) });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), []);
  assert.match(f.notices.at(-1).message, /cannot set how codemode presents the tools/);
});
