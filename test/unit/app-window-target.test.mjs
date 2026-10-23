import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { appService } from '../app-service-fixture.mjs';
import { enterText } from '../dom.mjs';

test('invalid window targets open editable fresh chats', { timeout: 120000 }, async t => {
  const cases = [
    ['a window with malformed target JSON opens an editable fresh chat', '/?target=%7B', 'Fresh chat after a damaged link'],
    ['a null window target opens an editable fresh chat', '/?target=null', 'Fresh chat'],
    ['a number window target opens an editable fresh chat', '/?target=42', 'Fresh chat'],
    ['a missing window target opens an editable fresh chat', '/', 'Fresh chat'],
  ];
  const app = await appService(t, { beforeMount() {
    window.history.replaceState(null, '', cases[0][1]);
  } });
  for (const [index, [name, path, draft]] of cases.entries()) await t.test(name, { timeout: 30000 }, async () => {
    if (index) {
      await enterText(app.root.querySelector('[aria-label="Message piop"]'), '');
      window.history.replaceState(null, '', path);
      await app.remount();
    }
    const editor = app.root.querySelector('[aria-label="Message piop"]');
    assert.equal(editor.value, '');
    await enterText(editor, draft);
    assert.equal(editor.value, draft);
    assert.ok(app.root.querySelector('[aria-label="Choose project"]'));
  });
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
