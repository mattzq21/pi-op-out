import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { appService } from '../app-service-fixture.mjs';
import { enterText } from '../dom.mjs';

test('a window with malformed target JSON opens an editable fresh chat', async t => {
  const { root, editor } = await appService(t, { beforeMount() {
    window.history.replaceState(null, '', '/?target=%7B');
  } });
  assert.equal(editor.value, '');
  await enterText(editor, 'Fresh chat after a damaged link');
  assert.equal(editor.value, 'Fresh chat after a damaged link');
  assert.ok(root.querySelector('[aria-label="Choose project"]'));
});

test('a null window target opens an editable fresh chat', async t => {
  const { root, editor } = await appService(t, { beforeMount() {
    window.history.replaceState(null, '', '/?target=null');
  } });
  assert.equal(editor.value, '');
  await enterText(editor, 'Fresh chat');
  assert.equal(editor.value, 'Fresh chat');
  assert.ok(root.querySelector('[aria-label="Choose project"]'));
});

test('a number window target opens an editable fresh chat', async t => {
  const { root, editor } = await appService(t, { beforeMount() {
    window.history.replaceState(null, '', '/?target=42');
  } });
  assert.equal(editor.value, '');
  await enterText(editor, 'Fresh chat');
  assert.equal(editor.value, 'Fresh chat');
  assert.ok(root.querySelector('[aria-label="Choose project"]'));
});

test('a missing window target opens an editable fresh chat', async t => {
  const { root, editor } = await appService(t, { beforeMount() {
    window.history.replaceState(null, '', '/');
  } });
  assert.equal(editor.value, '');
  await enterText(editor, 'Fresh chat');
  assert.equal(editor.value, 'Fresh chat');
  assert.ok(root.querySelector('[aria-label="Choose project"]'));
});

test('a valid window target selects its remote host and project', async t => {
  const hostId = crypto.randomUUID();
  const { root, editor } = await appService(t, {
    remotes: [{ id: hostId, name: 'Remote', target: 'window-target' }],
    async beforeMount({ daemon }) {
      const home = await daemon.invoke('home_directory', { hostId });
      const cwd = join(home, 'window-project');
      await mkdir(cwd);
      window.history.replaceState(null, '', '/?target=' + encodeURIComponent(JSON.stringify({ cwd, hostId })));
    },
  });
  assert.ok(root.querySelector('[aria-label="Selected project: window-project"]'));
  assert.ok(root.querySelector('[aria-label="Host: Remote"]'));
  await enterText(editor, 'Draft on the chosen host');
  assert.equal(editor.value, 'Draft on the chosen host');
});
