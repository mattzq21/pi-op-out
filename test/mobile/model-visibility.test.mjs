import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/modelVisibility.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });

const { recordSeenModels } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const settings = (overrides = {}) => ({ defaultModel: 'test/known', hiddenModels: [], ...overrides });

test('first sight baselines without hiding anything', () => {
  const next = recordSeenModels(settings(), ['test/known', 'test/other']);
  assert.deepEqual(next.knownModels, ['test/known', 'test/other']);
  assert.deepEqual(next.hiddenModels, []);
});

test('new arrivals are hidden while the default model stays visible', () => {
  const next = recordSeenModels(settings({ knownModels: ['test/known'] }), ['test/known', 'test/new', 'test/known']);
  assert.deepEqual(next.knownModels, ['test/known', 'test/new']);
  assert.deepEqual(next.hiddenModels, ['test/new']);
});

test('nothing changes when every model was seen before', () => {
  assert.equal(recordSeenModels(settings({ knownModels: ['test/known', 'test/old'], hiddenModels: ['test/old'] }), ['test/known', 'test/old']), undefined);
});
