import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

/** One assistant reply in the real message view. */
async function reply(t, content) {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/message-links-browser.tsx', ready: 'article', holdStorage: false,
    prepare: async page => {
      await page.exposeFunction('messageContent', () => content);
      await page.exposeFunction('nativeCommand', command => { throw new Error('Unexpected command: ' + command); });
    },
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  return page;
}

const flow = 'graph TD\n  A[Read the issue] --> B[Write a failing test]\n  B --> C[Fix the bug]';
const toolbar = page => page.locator('.diagram > .diagram-toolbar');
const dialog = page => page.locator('.diagram-dialog');

test('a reply becomes a diagram preview that shows its source, copies it, and opens an overlay to zoom', async t => {
  const page = await reply(t, 'Plan:\n\n```mermaid\n' + flow + '\n```\n');
  const thumb = page.locator('.diagram-thumb');
  await thumb.locator('svg').waitFor();
  for (const label of ['Read the issue', 'Write a failing test', 'Fix the bug']) assert.match(await thumb.textContent(), new RegExp(label));
  assert.equal(await page.locator('.diagram-source').count(), 0);

  await toolbar(page).getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await page.locator('.diagram-source').textContent(), flow);
  await toolbar(page).getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByText('Source copied').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), flow);

  await toolbar(page).getByRole('button', { name: 'Expand', exact: true }).click();
  const preview = page.getByRole('region', { name: /^Diagram preview/ });
  await preview.locator('svg').waitFor();
  const zoomOut = dialog(page).getByRole('button', { name: 'Zoom out', exact: true }), zoomIn = dialog(page).getByRole('button', { name: 'Zoom in', exact: true });
  await zoomOut.click(); await zoomOut.click();
  assert.equal(await zoomOut.isDisabled(), true);
  assert.equal(await dialog(page).getByRole('button', { name: '50%', exact: true }).count(), 1);
  for (let step = 0; step < 14; step++) await zoomIn.click();
  assert.equal(await zoomIn.isDisabled(), true);
  await dialog(page).getByRole('button', { name: '400%', exact: true }).click();
  assert.equal(await dialog(page).getByRole('button', { name: '100%', exact: true }).count(), 1, 'the zoom label resets the zoom');

  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await preview.isVisible(), false, 'closing the overlay hides the preview');
});

test('a diagram that cannot be drawn shows why, with its source', async t => {
  const page = await reply(t, '```mermaid\ngraph TD\n  A --> \n  ((( broken\n```\n');
  await page.getByText(/^Could not render diagram: /).waitFor();
  assert.match(await page.locator('.diagram-source').textContent(), /\(\(\( broken/);
  assert.equal(await page.locator('.diagram svg').count(), 0);
});

test('links and scripts in a diagram from a reply are removed', async t => {
  const page = await reply(t, '```mermaid\ngraph TD\n  A[Open me] --> B\n  click A href "javascript:window.opened=1"\n  click B href "https://example.com/tracking"\n```\n');
  const thumb = page.locator('.diagram-thumb');
  await thumb.locator('svg').waitFor();
  assert.equal(await thumb.locator('a, script, foreignObject, [href], [onclick]').count(), 0);
  await thumb.getByText('Open me').dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.opened), undefined);
});
