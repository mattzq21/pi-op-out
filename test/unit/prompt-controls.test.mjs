import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemo, createRoot } from 'solid-js';
import { discoveredModel, mergeModels } from '../../daemon/src/host/catalogs.ts';
import { PromptControls } from '../../clients/ui/lib/promptControls.ts';
import { modelSchema } from '../../clients/ui/lib/responseSchemas.ts';

const basic = { provider: 'custom', id: 'glm', reasoning: true };
const astra = { provider: 'openai', id: 'gpt-6-astra', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } };
const basicLevels = ['off', 'minimal', 'low', 'medium', 'high'];
const astraLevels = ['low', 'medium', 'high', 'xhigh', 'max'];

function discoveredAstra(saved = {}) {
  const discovered = discoveredModel({ id: astra.id }, [astra]);
  const [model] = mergeModels({ models: [{ id: astra.id, name: 'Astra 6', reasoning: true, ...saved }] }, [discovered]);
  return modelSchema.parse({ ...model, provider: 'custom' });
}

test('refreshing a discovered model restores effort settings without replacing explicit settings', () => {
  assert.deepEqual(discoveredAstra().thinkingLevelMap, astra.thinkingLevelMap);
  const explicit = { off: null, xhigh: null, max: null };
  assert.deepEqual(discoveredAstra({ thinkingLevelMap: explicit }).thinkingLevelMap, explicit);
});

test('effort choices update with the selected model and remain correct after sending', async () => {
  let dispose;
  const { controls, levels } = createRoot(cleanup => {
    dispose = cleanup;
    const controls = new PromptControls();
    controls.useEffectiveModel(basic);
    return { controls, levels: createMemo(() => controls.levels(basicLevels)) };
  });
  try {
    assert.deepEqual(levels(), basicLevels);
    const model = discoveredAstra();
    controls.model(model, 'high');
    assert.deepEqual(levels(), astraLevels);
    controls.thinking('max');
    const commands = [];
    await controls.flush(async command => commands.push(command), async () => {});
    assert.deepEqual(commands, [
      { type: 'set_model', provider: 'custom', modelId: astra.id },
      { type: 'set_thinking_level', level: 'max' },
    ]);
    controls.acknowledge({ model, thinkingLevel: 'max' });
    assert.equal(controls.hasPending(), false);
    assert.deepEqual(levels(), astraLevels);
    controls.model(basic, 'max');
    assert.deepEqual(levels(), basicLevels);
    assert.equal(controls.state({ model, thinkingLevel: 'max' }).thinkingLevel, 'high');
  } finally { dispose(); }
});

test('effort choices follow agent model changes rather than old session choices', () => {
  const controls = new PromptControls();
  assert.deepEqual(controls.levels(basicLevels), basicLevels);
  controls.useEffectiveModel(discoveredAstra());
  assert.deepEqual(controls.levels(basicLevels), astraLevels);
  controls.model(basic, 'high');
  assert.deepEqual(controls.levels(astraLevels), basicLevels);
  controls.reset();
  assert.deepEqual(controls.levels(basicLevels), astraLevels);
  controls.clearModel();
  assert.deepEqual(controls.levels(astraLevels), ['off']);
});
