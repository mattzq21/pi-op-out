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

for (const [choice, active, mode] of [
  [undefined, ['bash', 'codemode', 'read'], 'only'],
  ['only', ['bash', 'codemode', 'read'], 'only'],
  ['on', ['bash', 'codemode', 'read'], 'on'],
  ['off', ['bash', 'read'], 'on'],
]) {
  test(`codemode ${choice ?? 'missing'} sets the active tools and how codemode presents them`, async t => {
    const modes = recordModes(t);
    const extra = choice === undefined ? { tools: ['read', 'bash'] } : { tools: ['read', 'bash'], codemode: choice };
    const f = await agentFixture(t, { tools: ['read', 'bash', 'codemode'], config: configured([profile('general', extra)]) });
    await f.load(); await f.start();
    assert.deepEqual(f.pi.getActiveTools().toSorted(), active);
    assert.equal(modes.at(-1), mode);
  });
}

test('an agent cannot start when Piop cannot set how codemode presents the tools', async t => {
  Reflect.deleteProperty(globalThis, MODE);
  const f = await agentFixture(t, { tools: ['read', 'codemode'], config: configured([profile()]) });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), []);
  assert.match(f.notices.at(-1).message, /cannot set how codemode presents the tools/);
});
