import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture, profile, configured } from '../defined-agent-fixture.mjs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { installFastMode } from '../fast-mode-fixture.mjs';

const settings = createRequire(import.meta.url)('../../daemon/resources/session-broker/app-settings.cjs');

async function fastSettingsFixture(t, configs) {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, { model, models: [model] });
  for (const [path, enabled] of configs) settings.write(join(f.dir, path), JSON.stringify({ enabled }));
  await installFastMode(t, { dir: f.dir, pi: f.pi, ctx: f.ctx, models: [model], catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] });
  await f.start();
  return f;
}

test('legacy user settings do not enable fast mode', async t => {
  const f = await fastSettingsFixture(t, [['extensions/pi-openai-fast-mode-piop/config.json', true]]);
  assert.equal(await f.fastEnabled(), false);
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
});

test('manual fast mode off survives reload when fast mode loads first', async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model], config: null,
    realFastMode: { agentFirst: false, catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: true })]));
  await f.select('general');
  assert.equal(await f.fastEnabled(), true);
  await f.input('remember this agent');
  await f.commands.get('fast').handler('off', f.ctx);
  assert.equal(await f.fastEnabled(), false);
  await f.reloadExtensions();
  assert.equal(await f.fastEnabled(), false);
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
  assert.deepEqual(f.notices, []);
});

test("manual fast mode off survives reload when agents loads first", async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model], config: null,
    realFastMode: { agentFirst: true, catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: true })]));
  await f.select('general');
  assert.equal(await f.fastEnabled(), true);
  await f.input('remember this agent');
  await f.commands.get('fast').handler('off', f.ctx);
  assert.equal(await f.fastEnabled(), false);
  await f.reloadExtensions();
  assert.equal(await f.fastEnabled(), false);
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
  assert.deepEqual(f.notices, []);
});

test("manual fast mode on survives reload when fast mode loads first", async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model], config: null,
    realFastMode: { agentFirst: false, catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: false })]));
  await f.select('general');
  assert.equal(await f.fastEnabled(), false);
  await f.input('remember this agent');
  await f.commands.get('fast').handler('on', f.ctx);
  assert.equal(await f.fastEnabled(), true);
  await f.reloadExtensions();
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  assert.deepEqual(f.notices, []);
});

test("manual fast mode on survives reload when agents loads first", async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model], config: null,
    realFastMode: { agentFirst: true, catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: false })]));
  await f.select('general');
  assert.equal(await f.fastEnabled(), false);
  await f.input('remember this agent');
  await f.commands.get('fast').handler('on', f.ctx);
  assert.equal(await f.fastEnabled(), true);
  await f.reloadExtensions();
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  assert.deepEqual(f.notices, []);
});

test('user settings enable fast mode in provider requests', async t => {
  const f = await fastSettingsFixture(t, [['extensions/piop-openai-fast-mode/config.json', true]]);
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
});

test('legacy project settings do not override user fast mode', async t => {
  const f = await fastSettingsFixture(t, [
    ['extensions/piop-openai-fast-mode/config.json', true],
    ['.pi/pi-openai-fast-mode-piop/config.json', false],
  ]);
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
});

test('project settings override user fast mode in provider requests', async t => {
  const f = await fastSettingsFixture(t, [
    ['extensions/piop-openai-fast-mode/config.json', true],
    ['.pi/piop-openai-fast-mode/config.json', false],
  ]);
  assert.equal(await f.fastEnabled(), false);
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
});
