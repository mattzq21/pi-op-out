import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const list = JSON.parse(await readFile('extensions/piop-openai-fast-mode/src/anthropic-fast-models.json', 'utf8'));
const source = 'const ANTHROPIC_FAST_MODELS = ' + JSON.stringify(list) + ';\n' + await readFile('daemon/resources/fast-model-discovery.mjs', 'utf8');
const { createFastModelDiscovery } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function runtime(models, loggedIn) {
  return {
    refresh: async () => {},
    getProviders: () => [...new Set(models.map(model => model.provider))].map(id => ({ id })),
    getModels: provider => models.filter(model => model.provider === provider),
    getAuth: async () => loggedIn ? { auth: { apiKey: 'key' } } : undefined,
  };
}

const anthropic = id => ({ provider: 'anthropic', id, api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' });
const others = [anthropic('claude-opus-5-5'), anthropic('claude-opus-4-8'), anthropic('claude-haiku-5-5'), { provider: 'opencode-go', id: 'claude-haiku-5-5', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/inference/go' }];

test('Anthropic fast models are the listed models that the host has, with a login, and other Anthropic API providers are not scanned', async () => {
  const [result, ...rest] = await createFastModelDiscovery(runtime(others, true)).scan();
  assert.equal(rest.length, 0);
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.supportedModelIds, ['claude-opus-5-5', 'claude-opus-4-8']);
  assert.deepEqual((await createFastModelDiscovery(runtime(others, false)).scan('anthropic'))[0].supportedModelIds, []);
});
