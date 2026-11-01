import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startupPage } from '../startup-browser-fixture.mjs';
import { testBrowserName } from '../test-browser.mjs';

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

test('panning a preview stops when the button is released, also after a double click selects a label', { skip: testBrowserName !== 'webkit' && 'needs real X pointer input' }, async t => {
  const page = await reply(t, '```mermaid\nstateDiagram-v2\n  s0: Cart\n  s1: Paying\n  [*] --> s0\n  s0 --> s1: you press pay\n```\n');
  await toolbar(page).getByRole('button', { name: 'Expand', exact: true }).click();
  const viewport = page.getByRole('region', { name: /^Diagram preview/ });
  const label = viewport.locator('svg text', { hasText: 'Cart' }).first();
  await label.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center' }));
  const box = await label.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  // Real X input: a press on selected text starts a native drag, and WebKitGTK then gives the page no pointerup.
  const [left, top] = await page._xOrigin(), input = await page._context._session.xInput();
  const move = async (dx, dy) => { await input.request({ action: 'move', x: Math.round(left + x + dx), y: Math.round(top + y + dy) }); await delay(16); };
  const button = async down => { await input.request({ action: 'button', button: 1, down }); await delay(40); };
  await move(0, 0);
  for (let click = 0; click < 2; click++) { await button(true); await button(false); }
  await delay(1200);
  const position = () => viewport.evaluate(element => new Promise(resolve => {
    requestAnimationFrame(() => resolve([element.scrollLeft, element.scrollTop]));
  }));
  const before = await position();
  await button(true);
  for (let step = 1; step <= 15; step++) await move(-step * 6, -step * 4);
  await button(false);
  const released = await position();
  assert.notDeepEqual(released, before, 'dragging must move the preview before release');
  for (let step = 1; step <= 15; step++) await move(step * 6, step * 4);
  assert.deepEqual(await position(), released, 'the view does not follow the pointer after the release');
});
