import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appService } from '../app-service-fixture.mjs';
import { act } from '../dom.mjs';

async function modelApp(t, overrides = {}) {
  return appService(t, { async beforeMount({ daemon }) {
    const home = await daemon.invoke('home_directory', { hostId: 'local' });
    const directory = join(home, '.piop');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { 'visibility-test': {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'unused-test-key',
      models: [{ id: 'known', name: 'Known' }, { id: 'other', name: 'Other' }],
    } } }));
    const original = await daemon.invoke('load_app_settings');
    await daemon.invoke('save_host_settings', { hostId: 'local', agentsChanged: false, settings: { ...original, hiddenModels: [], ...overrides } });
  } });
}

test('model picker reports and applies settings changes', { timeout: 90000 }, async t => {
  const { root, daemon, settle } = await modelApp(t);
  await t.test('the first model report keeps every configured model available in the composer', { timeout: 30000 }, async () => {
    await act(() => root.querySelector('[aria-label="Model"]').click());
    assert.deepEqual([...root.querySelectorAll('[role="listbox"][aria-label="Model options"] [role="option"]')].map(node => node.textContent), ['Knownvisibility-test', 'Othervisibility-test']);
    await settle();
    const settings = await daemon.invoke('load_app_settings');
    assert.deepEqual(settings.knownModels, ['visibility-test/known', 'visibility-test/other']);
    assert.deepEqual(settings.hiddenModels, []);
  });
  await t.test('saved aliases update an open model picker and can be cleared without changing model IDs', { timeout: 30000 }, async () => {
    const options = () => [...root.querySelectorAll('[role="listbox"][aria-label="Model options"] [role="option"]')];
    const saveAlias = async alias => {
      const settings = await daemon.invoke('load_app_settings');
      await act(async () => {
        await daemon.invoke('save_host_settings', { hostId: 'local', agentsChanged: false, settings: { ...settings, modelAliases: { 'visibility-test/known': alias } } });
        await settle();
      });
    };
    await saveAlias('  My model  ');
    assert.deepEqual(options().map(node => node.textContent), ['My modelvisibility-test', 'Othervisibility-test']);
    assert.deepEqual((await daemon.invoke('load_app_settings')).modelAliases, { 'visibility-test/known': 'My model' });
    await saveAlias('');
    assert.deepEqual(options().map(node => node.textContent), ['Knownvisibility-test', 'Othervisibility-test']);
  });
  await t.test('saved model visibility updates an open model picker when a model is hidden and shown again', { timeout: 30000 }, async () => {
    const options = () => [...root.querySelectorAll('[role="listbox"][aria-label="Model options"] [role="option"]')].map(node => node.textContent);
    const saveHidden = async hiddenModels => {
      const settings = await daemon.invoke('load_app_settings');
      await act(async () => {
        await daemon.invoke('save_host_settings', { hostId: 'local', agentsChanged: false, settings: { ...settings, hiddenModels } });
        await settle();
      });
    };
    assert.deepEqual(options(), ['Knownvisibility-test', 'Othervisibility-test']);
    await saveHidden(['visibility-test/other']);
    assert.deepEqual(options(), ['Knownvisibility-test']);
    await saveHidden([]);
    assert.deepEqual(options(), ['Knownvisibility-test', 'Othervisibility-test']);
    const settings = await daemon.invoke('load_app_settings');
    assert.deepEqual(settings.knownModels, ['visibility-test/known', 'visibility-test/other']);
    assert.deepEqual(settings.hiddenModels, []);
  });
});

test('a later model report hides new arrivals and keeps the known default visible', async t => {
  const { root, daemon, settle } = await modelApp(t, { knownModels: ['visibility-test/known'] });
  await act(() => root.querySelector('[aria-label="Model"]').click());
  assert.deepEqual([...root.querySelectorAll('[role="listbox"][aria-label="Model options"] [role="option"]')].map(node => node.textContent), ['Knownvisibility-test']);
  await settle();
  const settings = await daemon.invoke('load_app_settings');
  assert.deepEqual(settings.knownModels, ['visibility-test/known', 'visibility-test/other']);
  assert.deepEqual(settings.hiddenModels, ['visibility-test/other']);
});

test('reporting known models preserves the users visible model list', async t => {
  const { root, remount, daemon, settle } = await modelApp(t, { knownModels: ['visibility-test/known', 'visibility-test/other'], hiddenModels: ['visibility-test/other'] });
  await act(() => root.querySelector('[aria-label="Model"]').click());
  assert.deepEqual([...root.querySelectorAll('[role="listbox"][aria-label="Model options"] [role="option"]')].map(node => node.textContent), ['Knownvisibility-test']);
  await settle();
  const before = await daemon.invoke('load_app_settings');
  await remount();
  await act(() => root.querySelector('[aria-label="Model"]').click());
  assert.deepEqual([...root.querySelectorAll('[role="listbox"][aria-label="Model options"] [role="option"]')].map(node => node.textContent), ['Knownvisibility-test']);
  await settle();
  const after = await daemon.invoke('load_app_settings');
  assert.deepEqual(after.knownModels, ['visibility-test/known', 'visibility-test/other']);
  assert.deepEqual(after.hiddenModels, ['visibility-test/other']);
  assert.equal(typeof before.settingsRevision, 'string');
  assert.ok(before.settingsRevision.length > 0);
  assert.equal(after.settingsRevision, before.settingsRevision);
});
