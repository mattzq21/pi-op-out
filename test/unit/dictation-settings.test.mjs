import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createComponent, createSignal } from 'solid-js';
import { act, enterText, installDom, renderComponent, untilDom } from '../dom.mjs';
import { clearMocks, mockIPC } from '../mock-ipc.mjs';
import { DictationSettings } from '../../clients/ui/components/DictationSettings.tsx';

let dom, view, settings, searches;

beforeEach(() => {
  dom = installDom(); searches = [];
  mockIPC((command, args) => {
    if (command === 'dictation_find_engines') { searches.push(args.paths); return { 'transcribe.cpp': { executable: '/usr/bin/python3' }, needle: { error: 'needle is not on PATH' } }; }
    throw new Error('Unexpected command: ' + command);
  }, { shouldMockEvents: true });
});
afterEach(async () => { await view?.unmount(); view = undefined; clearMocks(); dom.restore(); });

/** The dictation section as the settings editor uses it: each change is merged into the draft settings. */
async function render(initial = {}) {
  view = await renderComponent(() => {
    const [draft, setDraft] = createSignal({ dictationEngines: [], ...initial });
    settings = draft;
    return createComponent(DictationSettings, { get settings() { return draft(); }, onChange: patch => setDraft(current => ({ ...current, ...patch })) });
  });
}

const button = text => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text || item.getAttribute('aria-label') === text);
const control = label => document.querySelector(`[aria-label="${label}"]`);
const click = element => act(async () => element.click());
const models = () => [...document.querySelectorAll('[aria-label="Dictation model"] [role="radio"]')].map(item => [item.querySelector('strong').textContent, item.getAttribute('aria-checked')]);

async function addModel(path, { name = '', args = '' } = {}) {
  await click(button('Add model'));
  if (name) await enterText(control('Model name'), name);
  await enterText(control('Model file path'), path);
  if (args) await enterText(control('Engine arguments'), args);
  await click(button('Add'));
}

test('an added engine is used at once, and only a model file of its type can be added', async () => {
  await render();
  await click(button('Add engine'));
  await click(button('Transcribe.cpp'));
  assert.equal(settings().dictationEngine, 'transcribe.cpp');
  assert.match(document.body.textContent, /No models yet\./);

  await click(button('Add model'));
  await enterText(control('Model file path'), '/models/whisper.bin');
  assert.match(document.body.textContent, /Transcribe\.cpp needs a \.gguf file\./);
  assert.equal(button('Add').disabled, true);
  await click(button('Cancel'));

  await addModel('/models/whisper.gguf', { args: '  --language   en ' });
  assert.deepEqual(models(), [['whisper.gguf--language en', 'true']]);
  assert.deepEqual([settings().dictationModelPath, settings().dictationArgs], ['/models/whisper.gguf', '--language en']);
});

test('models can be chosen, renamed in place and removed; removing the model in use picks the next one', async () => {
  await render();
  await click(button('Add engine')); await click(button('Transcribe.cpp'));
  await addModel('/models/small.gguf');
  await addModel('/models/large.gguf');
  assert.deepEqual(models(), [['small.gguf', 'false'], ['large.gguf', 'true']]);

  await click(document.querySelector('[aria-label="Dictation model"] [role="radio"]'));
  assert.equal(settings().dictationModelPath, '/models/small.gguf');
  await click(button('Edit small.gguf'));
  await enterText(control('Model name'), 'Fast');
  await click(button('Save'));
  assert.deepEqual(models(), [['Fast', 'true'], ['large.gguf', 'false']]);

  await click(button('Remove Fast'));
  assert.deepEqual(models(), [['large.gguf', 'true']]);
  assert.equal(settings().dictationModelPath, '/models/large.gguf');
});

test('each engine shows whether its program was found, and removing the engine in use switches to the other one', async () => {
  await render({ dictationEngines: [{ engine: 'transcribe.cpp', models: [{ path: '/models/a.gguf' }] }, { engine: 'needle', models: [{ path: '/models/b.cact' }] }], dictationEngine: 'needle', dictationModelPath: '/models/b.cact' });
  await untilDom(() => /Not found/.test(document.querySelector('[aria-label="Dictation engine"]').textContent));
  const tiles = () => [...document.querySelectorAll('.dictation-engine')].map(tile => [tile.querySelector('strong').textContent, /Not found/.test(tile.textContent)]);
  assert.deepEqual(tiles(), [['Transcribe.cpp', false], ['Needle', true]]);
  await click(button('Needle settings'));
  assert.match(document.querySelector('.dictation-found').textContent, /needle is not on PATH/);
  await click(button('Transcribe.cpp settings'));
  assert.match([...document.querySelectorAll('.dictation-found')].map(item => item.textContent).join(' '), /Program: \/usr\/bin\/python3/);

  await click(button('Remove Needle'));
  assert.deepEqual([settings().dictationEngine, settings().dictationModelPath], ['transcribe.cpp', '/models/a.gguf']);
  assert.deepEqual(tiles(), [['Transcribe.cpp', false]]);
});
