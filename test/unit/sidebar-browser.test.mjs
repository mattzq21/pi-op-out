import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { chromium } from 'playwright-core';

let server, browser, url;
before(async () => {
  const bundle = await build({
    entryPoints: ['test/fixtures/sidebar.tsx'], bundle: true, write: false, conditions: ['browser'],
    plugins: [{ name: 'solid', setup(api) {
      api.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({ contents: transformSync(await readFile(path, 'utf8'), {
        filename: path, babelrc: false, configFile: false,
        presets: [[solid, { generate: 'dom' }], [typescript, { onlyRemoveTypeImports: true }]],
      }).code, loader: 'js' }));
    } }],
  });
  const css = await readFile('clients/ui/styles.css', 'utf8');
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : req.url === '/app.css' ? css : '<link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? chromium.executablePath(), headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function openSidebar(t, { storageUnavailable = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(() => {
    if (storageUnavailable) {
      assert.ok(errors.some(message => /Could not restore panel size.*blocked/s.test(message)));
      assert.ok(errors.some(message => /Could not save panel sizes.*blocked/s.test(message)));
      assert.deepEqual(errors.filter(message => !/Could not (restore panel size|save panel sizes).*blocked/s.test(message)), []);
    } else assert.deepEqual(errors, []);
  });
  // Wait on the browser's storage events, without knowing database names or records.
  await page.addInitScript(() => {
    const pending = new Set();
    function track(target, done) {
      const settled = new Promise(resolve => {
        target.addEventListener(done, resolve, { once: true });
        target.addEventListener('error', resolve, { once: true });
        target.addEventListener('abort', resolve, { once: true });
      });
      pending.add(settled);
      settled.then(() => pending.delete(settled));
      return target;
    }
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { return track(open.apply(this, args), 'success'); };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) { return track(transaction.apply(this, args), 'complete'); };
    window.settleStorage = async () => { while (pending.size) await Promise.all([...pending]); };
  });
  if (storageUnavailable) await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new Error('blocked'); };
  });
  await page.goto(url);
  await page.getByRole('separator', { name: 'Sidebar width' }).waitFor();
  await page.evaluate(() => window.settleStorage());
  return page;
}

describe('sidebar behavior', { concurrency: 4 }, () => {
  test('sidebar width survives a browser reload', async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.press('Home');
    await separator.press('Shift+ArrowRight');
    await separator.press('ArrowRight');
    assert.equal(await separator.getAttribute('aria-valuenow'), '260');
    await page.evaluate(() => window.settleStorage());
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.reload();
    await separator.waitFor();
    await page.evaluate(() => window.settleStorage());
    assert.equal(await separator.getAttribute('aria-valuenow'), '260');
  });

  test("sidebar keyboard resizing uses small and large steps within its limits", async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.press('Home');
    await separator.press('ArrowRight');
    assert.equal(await separator.getAttribute('aria-valuenow'), '210');
    await separator.press('Shift+ArrowRight');
    assert.equal(await separator.getAttribute('aria-valuenow'), '260');
    await separator.press('Shift+ArrowLeft');
    assert.equal(await separator.getAttribute('aria-valuenow'), '210');
    await separator.press('Home'); await separator.press('ArrowLeft');
    assert.equal(await separator.getAttribute('aria-valuenow'), '200');
    await separator.press('a');
    assert.equal(await separator.getAttribute('aria-valuenow'), '200');
    await separator.press('End'); await separator.press('ArrowRight');
    assert.equal(await separator.getAttribute('aria-valuenow'), '600');
    await page.evaluate(() => window.settleStorage());
  });

  test("a narrower viewport keeps the sidebar within its new width limit", async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.press('End');
    assert.equal(await separator.getAttribute('aria-valuenow'), '600');
    await page.setViewportSize({ width: 400, height: 700 });
    await separator.evaluate(element => new Promise(resolve => {
      if (element.getAttribute('aria-valuenow') === '200') { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (element.getAttribute('aria-valuenow') !== '200') return;
        observer.disconnect(); resolve();
      });
      observer.observe(element, { attributes: true, attributeFilter: ['aria-valuenow'] });
    }));
    assert.equal(await separator.getAttribute('aria-valuenow'), '200');
    await page.evaluate(() => window.settleStorage());
  });

  test("double clicking the sidebar handle restores the viewport default", async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.press('End'); await separator.dblclick();
    assert.equal(await separator.getAttribute('aria-valuenow'), '320');
    await page.setViewportSize({ width: 1000, height: 700 });
    await separator.dblclick();
    assert.equal(await separator.getAttribute('aria-valuenow'), '280');
    await page.evaluate(() => window.settleStorage());
  });

  test("a compact sidebar has no resize handle", async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    assert.equal(await separator.count(), 1);
    await page.getByRole('button', { name: 'Toggle compact sidebar' }).click();
    assert.equal(await separator.count(), 0);
    assert.ok(await page.getByText('Sessions', { exact: true }).isVisible());
  });

  test('sidebar dragging ignores other pointers and restores text selection on release', async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    const box = await separator.boundingBox();
    const initial = Number(await separator.getAttribute('aria-valuenow'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + 50, box.y + box.height / 2);
    await page.mouse.up({ button: 'right' });
    await page.keyboard.press('Escape');
    assert.equal(Number(await separator.getAttribute('aria-valuenow')), initial);
    const current = await separator.boundingBox();
    await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2);
    await page.mouse.down();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
    await separator.dispatchEvent('pointermove', { pointerId: 999, clientX: 800, isPrimary: false });
    await separator.dispatchEvent('pointerup', { pointerId: 999 });
    assert.equal(Number(await separator.getAttribute('aria-valuenow')), initial);
    await page.mouse.move(current.x + current.width / 2 + 50, current.y + current.height / 2);
    assert.equal(Number(await separator.getAttribute('aria-valuenow')), initial + 50);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).cursor), 'default');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
  });

  test('sidebar dragging keeps the application cursor', async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.hover();
    await page.mouse.down();
    try {
      assert.equal(await separator.evaluate(element => getComputedStyle(element).cursor), 'default');
    } finally { await page.mouse.up(); }
  });

  test('cancelling a sidebar drag restores text selection', async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.hover();
    await page.mouse.down();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
    await separator.dispatchEvent('pointercancel');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
    await page.mouse.up();
  });

  test('losing pointer capture ends a sidebar drag and permits resetting its width', async t => {
    const page = await openSidebar(t);
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    await separator.evaluate(element => element.addEventListener('pointerdown', event => { window.sidebarPointerId = event.pointerId; }, { once: true }));
    await separator.hover();
    await page.mouse.down();
    await page.mouse.move(350, 45);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
    const width = await separator.getAttribute('aria-valuenow');
    await separator.evaluate(element => {
      window.sidebarCaptureLost = new Promise(resolve => element.addEventListener('lostpointercapture', resolve, { once: true }));
      element.releasePointerCapture(window.sidebarPointerId);
    });
    await page.mouse.move(450, 45);
    await page.evaluate(() => window.sidebarCaptureLost);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
    assert.equal(await separator.getAttribute('aria-valuenow'), width);
    await page.mouse.up();
    await page.setViewportSize({ width: 1000, height: 700 });
    await separator.dblclick();
    assert.equal(await separator.getAttribute('aria-valuenow'), '280');
  });

  test('sidebar resizing remains usable when browser storage is unavailable', async t => {
    const page = await openSidebar(t, { storageUnavailable: true });
    const separator = page.getByRole('separator', { name: 'Sidebar width' });
    assert.equal(await separator.getAttribute('aria-valuenow'), '320');
    const savedFailure = page.waitForEvent('console', message => message.type() === 'error' && message.text().includes('Could not save panel sizes'));
    await separator.press('Shift+ArrowRight');
    assert.equal(await separator.getAttribute('aria-valuenow'), '370');
    await savedFailure;
    await separator.dblclick();
    assert.equal(await separator.getAttribute('aria-valuenow'), '320');
  });
});
