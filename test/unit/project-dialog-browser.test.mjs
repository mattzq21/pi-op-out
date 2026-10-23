import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { startupPage } from '../startup-browser-fixture.mjs';

async function projectPage(t, { open = async () => {}, beforeList = async () => {}, beforeHome = async () => {}, homePath, list } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'piop-project-dialog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const remoteHome = await mkdtemp(join(tmpdir(), 'piop-project-remote-'));
  t.after(() => rm(remoteHome, { recursive: true, force: true }));
  await mkdir(join(remoteHome, 'new'));
  for (const name of ['alpha', 'beta', 'zalpha']) await mkdir(join(home, name));
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/project-dialog-browser.tsx', ready: '[role="combobox"]', holdStorage: false,
    prepare: async page => {
      await page.exposeFunction('projectHome', async host => { await beforeHome(host); return homePath ?? (host === 'remote' ? remoteHome : home); });
      await page.exposeFunction('openProject', open);
      await page.exposeFunction('listProjectFolders', async (path, host) => {
        if (list) return list(path, host);
        const listing = { path, parent: dirname(path), directories: (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)) };
        await beforeList(path, host);
        return listing;
      });
    },
  });
  return { page, home, remoteHome };
}

test('clicking the folder dialog backdrop cancels only outside its bounds', async t => {
  const { page } = await projectPage(t);
  const dialog = page.getByRole('dialog', { name: 'Jump to a folder' });
  await page.getByRole('heading', { name: 'Jump to a folder' }).click();
  assert.equal(await page.getByLabel('Cancelled dialogs').textContent(), '0');
  assert.equal(await dialog.isVisible(), true);
  const box = await dialog.boundingBox();
  assert.ok(box.x > 20);
  await page.mouse.click(box.x - 20, box.y + box.height / 2);
  assert.equal(await page.getByLabel('Cancelled dialogs').textContent(), '1');
  assert.equal(await dialog.count(), 0);
});

test('home-relative filtering ranks prefixes first and Enter opens the selected folder', async t => {
  const { page, home } = await projectPage(t);
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  assert.equal(await input.inputValue(), '');
  const options = page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'zalpha', exact: true }).waitFor();
  assert.deepEqual(await options.allTextContents(), ['alpha', 'beta', 'zalpha']);
  await input.fill('ALP');
  assert.deepEqual(await options.allTextContents(), ['alpha', 'zalpha']);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { selected: true }).textContent(), 'zalpha');
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[join(home, 'zalpha'), 'local']]);
});

test('Tab completes the selected folder and lists its children', async t => {
  const { page, home } = await projectPage(t);
  await mkdir(join(home, 'alpha', 'child'));
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  await input.fill('al');
  await page.keyboard.press('Tab');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'child', exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'alpha/');
  assert.deepEqual(await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option').allTextContents(), ['child']);
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
});

test('mouse selection browses folders and keyboard navigation wraps around the result list', async t => {
  const { page, home } = await projectPage(t);
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'zalpha', exact: true }).waitFor();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { selected: true }).textContent(), 'zalpha');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { selected: true }).textContent(), 'alpha');
  const beta = page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'beta', exact: true });
  await beta.hover();
  assert.equal(await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { selected: true }).textContent(), 'beta');
  await beta.click();
  assert.equal(await page.getByRole('combobox', { name: 'Folder path relative to home' }).inputValue(), 'beta/');
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Open current folder/ }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[join(home, 'beta') + '/', 'local']]);
});

test('Alt Backspace navigates to the parent folder', async t => {
  const { page, home } = await projectPage(t);
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  await input.fill('alpha/');
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  await page.keyboard.press('Alt+Backspace');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Control+Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[home + '/', 'local']]);
});

test('undo and redo restore a folder navigation change', async t => {
  const { page } = await projectPage(t);
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  await input.fill('al');
  await page.keyboard.press('Tab');
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  await page.keyboard.press('Alt+Backspace');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  await page.keyboard.press('Control+z');
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'alpha/');
  await page.keyboard.press('Control+y');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), []);
});

test('the current folder opens with Ctrl+Enter and duplicate open requests are suppressed', async t => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const { page, home } = await projectPage(t, { open: () => { started.resolve(); return pending.promise; } });
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  try {
    await page.keyboard.press('Control+Enter');
    await started.promise;
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[home + '/', 'local']]);
    assert.equal(await input.evaluate(node => node.readOnly), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Cancelled dialogs').textContent(), '0');
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    pending.reject(new Error('cannot open'));
    await page.getByRole('alert').filter({ hasText: 'cannot open' }).waitFor();
    assert.equal(await input.evaluate(node => node.readOnly), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Cancelled dialogs').textContent(), '1');
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally { pending.resolve(); }
});

test('after a folder fails to open, choosing another folder opens it and clears the error', { timeout: 15000 }, async t => {
  let attempts = 0;
  const { page, home } = await projectPage(t, { open: async () => { attempts += 1; if (attempts === 1) throw new Error('home cannot open'); } });
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  const error = page.getByRole('alert');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'alpha', exact: true }).waitFor();
  await page.keyboard.press('Control+Enter');
  await error.filter({ hasText: 'home cannot open' }).waitFor();
  await input.fill('alpha/');
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  await page.keyboard.press('Control+Enter');
  await page.getByRole('button', { name: /Open current folder/ }).waitFor();
  assert.equal(await error.count(), 0);
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[home + '/', 'local'], [join(home, 'alpha') + '/', 'local']]);
});

test('stale directory responses cannot replace the newly selected host', async t => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const { page, remoteHome } = await projectPage(t, {
    beforeList: async (_path, host) => { if (host === 'local') { started.resolve(); await pending.promise; } },
  });
  try {
    await started.promise;
    await page.getByRole('combobox', { name: 'Host' }).selectOption('remote');
    await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'new', exact: true }).waitFor();
    assert.deepEqual(await page.getByRole('listbox').getByRole('option').allTextContents(), ['new']);
    pending.resolve();
    await page.getByLabel('Delivered listings').evaluate(node => new Promise(resolve => {
      const observer = new MutationObserver(check);
      function check() { if (node.textContent === '2') { observer.disconnect(); resolve(); } }
      observer.observe(node, { childList: true, characterData: true, subtree: true });
      check();
    }));
    await page.getByRole('combobox', { name: 'Folder path relative to home' }).focus();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[remoteHome + '/', 'remote']]);
    assert.deepEqual(await page.getByRole('listbox').getByRole('option').allTextContents(), ['new']);
  } finally { pending.resolve(); }
});

test('home and listing failures explain the problem and do not enable opening', async t => {
  const { page } = await projectPage(t);
  const base = page.url();
  await page.goto(base + '?failure=home');
  const error = page.getByRole('alert');
  await error.waitFor();
  assert.equal(await error.textContent(), 'home unavailable');
  const open = page.getByRole('button', { name: /Open current folder/ });
  assert.equal(await open.isDisabled(), true);
  await page.goto(base + '?failure=listing');
  await error.waitFor();
  assert.match(await error.textContent(), /Could not list this folder/);
  assert.equal(await open.isDisabled(), true);
  await page.getByRole('combobox', { name: 'Folder path relative to home' }).fill('alpha/');
  await error.waitFor();
  assert.equal(await error.textContent(), 'listing failed');
  assert.equal(await open.isDisabled(), true);
  await page.keyboard.press('Control+Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), []);
});

test('Windows home paths expand separators and folders outside home open without suggestions', async t => {
  const requested = [];
  const { page } = await projectPage(t, {
    homePath: 'C:\\Users\\Me',
    list: async path => { requested.push(path); return { path, directories: [] }; },
  });
  const url = new URL(page.url());
  url.searchParams.set('path', '~/project');
  await page.goto(url.href);
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  assert.equal(requested.at(-1), 'C:\\Users\\Me\\project\\');
  const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
  assert.equal(await input.inputValue(), 'project/');
  url.searchParams.set('path', 'D:\\repo\\');
  await page.goto(url.href);
  await page.getByText('No child folders. Press Enter to open this folder.', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Search or type a folder path', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [['D:\\repo\\', 'local']]);
});

test('a late home folder from the previous machine cannot replace the newly selected machine', async t => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const { page, remoteHome } = await projectPage(t, {
    beforeHome: async host => { if (host === 'local') { started.resolve(); await pending.promise; } },
  });
  try {
    await started.promise;
    await page.getByRole('combobox', { name: 'Host' }).selectOption('remote');
    await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'new', exact: true }).waitFor();
    pending.resolve();
    await page.getByLabel('Settled home requests').evaluate(node => new Promise(resolve => {
      const observer = new MutationObserver(check);
      function check() { if (node.textContent === '2') { observer.disconnect(); resolve(); } }
      observer.observe(node, { childList: true, characterData: true, subtree: true });
      check();
    }));
    const input = page.getByRole('combobox', { name: 'Folder path relative to home' });
    assert.equal(await input.inputValue(), '');
    assert.deepEqual(await page.getByRole('listbox').getByRole('option').allTextContents(), ['new']);
    await input.focus();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[remoteHome + '/', 'remote']]);
  } finally { pending.resolve(); }
});

test('after a home folder failure, choosing another machine clears the error and allows opening', async t => {
  const { page, remoteHome } = await projectPage(t, {
    beforeHome: async host => { if (host === 'local') throw new Error('local home unavailable'); },
  });
  const error = page.getByRole('alert');
  await error.waitFor();
  assert.match(await error.textContent(), /local home unavailable/);
  const open = page.getByRole('button', { name: /Open current folder/ });
  assert.equal(await open.isDisabled(), true);
  await page.getByRole('combobox', { name: 'Host' }).selectOption('remote');
  await page.getByRole('listbox', { name: 'Matching folders' }).getByRole('option', { name: 'new', exact: true }).waitFor();
  assert.equal(await error.count(), 0);
  assert.equal(await open.isDisabled(), false);
  await open.click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Opened folders').textContent()), [[remoteHome + '/', 'remote']]);
});
