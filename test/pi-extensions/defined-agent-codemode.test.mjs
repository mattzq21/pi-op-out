import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture, profile, configured } from '../defined-agent-fixture.mjs';

for (const [choice, active] of [
  [undefined, ['bash', 'codemode', 'read']],
  ['on', ['bash', 'codemode', 'read']],
  ['off', ['bash', 'read']],
]) {
  test(`codemode ${choice ?? 'missing'} sets whether the agent has the codemode tool`, async t => {
    const extra = choice === undefined ? { tools: ['read', 'bash'] } : { tools: ['read', 'bash'], codemode: choice };
    const f = await agentFixture(t, { tools: ['read', 'bash', 'codemode'], config: configured([profile('general', extra)]) });
    await f.load(); await f.start();
    assert.deepEqual(f.pi.getActiveTools().toSorted(), active);
  });
}
