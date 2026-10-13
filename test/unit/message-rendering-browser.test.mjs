import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

async function messagePage(t, kind = 'source') {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/message-rendering-browser.tsx', ready: '[aria-label="Copy message"]', holdStorage: false,
  });
  if (kind !== 'source') await page.goto(page.url() + '?kind=' + kind);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('article').hover();
  return page;
}

test('message copying preserves source text and reports unavailable clipboard access', async t => {
  const page = await messagePage(t);
  await page.getByRole('button', { name: 'Copy message', exact: true }).click();
  await page.getByRole('button', { name: 'Message copied', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '**source**');
  await page.getByRole('button', { name: 'Copy message', exact: true }).waitFor();
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.execCommand = () => false; });
  await page.getByRole('button', { name: 'Copy message', exact: true }).click();
  const error = page.getByRole('status').filter({ hasText: 'Could not copy message' });
  await error.waitFor();
  await error.waitFor({ state: 'detached' });
});

test('fenced code copying omits the trailing newline and handles write failures', async t => {
  const page = await messagePage(t, 'code');
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await page.getByRole('button', { name: 'Code copied', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const answer = 42;');
  await page.getByRole('button', { name: 'Copy code', exact: true }).waitFor();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); }; document.execCommand = () => false; });
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Could not copy' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const answer = 42;');
});

test('link context menus copy the URL, restore focus and report clipboard failures', async t => {
  const page = await messagePage(t, 'link');
  const link = page.getByRole('link', { name: 'link', exact: true });
  await link.focus();
  await link.click({ button: 'right' });
  const item = page.getByRole('menuitem');
  await item.waitFor();
  assert.equal(await item.evaluate(node => node === document.activeElement), true);
  await item.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://example.com/');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await link.evaluate(node => node === document.activeElement), true);
  await link.click({ button: 'right' });
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.execCommand = () => false; });
  await page.getByRole('menuitem').click();
  await page.getByRole('alert').filter({ hasText: 'Could not copy link' }).waitFor();
});

test('context menus close on Escape, Tab, scrolling and outside clicks and keep focus inside while navigating', async t => {
  const page = await messagePage(t, 'link');
  const link = page.getByRole('link', { name: 'link', exact: true });
  await link.focus();
  await link.click({ button: 'right' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await link.evaluate(node => node === document.activeElement), true);
  await link.click({ button: 'right' });
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Copy assistant response link', exact: true }).evaluate(node => node === document.activeElement), true);
  await link.click({ button: 'right' });
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('menuitem').evaluate(node => node === document.activeElement), true);
  await page.getByRole('main').hover();
  await page.mouse.wheel(0, 250);
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.ok(await page.getByRole('main').evaluate(node => node.scrollTop) > 0);
  await link.click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  await page.getByRole('button', { name: 'Outside message', exact: true }).click();
  assert.equal(await page.getByRole('menu').count(), 0);
});

test('only supported inline attachments render and remote Markdown images remain inert', async t => {
  const requested = [];
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/message-images-browser.tsx', ready: 'img', holdStorage: false,
    prepare: async page => {
      await page.route('https://example.com/**', route => { requested.push(route.request().url()); return route.abort(); });
    },
  });
  assert.equal(await page.locator('img').count(), 1);
  const dimensions = await page.locator('img').evaluate(async node => { await node.decode(); return [node.naturalWidth, node.naturalHeight]; });
  assert.deepEqual(dimensions, [1, 1]);
  assert.equal(await page.locator('img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC');
  assert.equal(await page.getByLabel('external', { exact: true }).isVisible(), true);
  assert.deepEqual(requested, []);
  await page.getByRole('button', { name: 'Show assistant image', exact: true }).click();
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.getByLabel('Blocked remote image', { exact: true }).isVisible(), true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.deepEqual(requested, []);
});
