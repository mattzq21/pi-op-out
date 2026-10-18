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
const controls = page => page.getByRole('group', { name: 'Diagram controls' });

test('a Mermaid block in a reply becomes a diagram whose source can be shown, copied and zoomed', async t => {
  const page = await reply(t, 'Plan:\n\n```mermaid\n' + flow + '\n```\n');
  const diagram = page.getByRole('region', { name: /^Diagram preview/ });
  await diagram.locator('svg').waitFor();
  for (const label of ['Read the issue', 'Write a failing test', 'Fix the bug']) assert.match(await diagram.textContent(), new RegExp(label));
  assert.equal(await page.locator('.diagram-source').count(), 0);

  await controls(page).getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await page.locator('.diagram-source').textContent(), flow);
  await controls(page).getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByText('Source copied').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), flow);

  const zoomOut = controls(page).getByRole('button', { name: 'Zoom out', exact: true }), zoomIn = controls(page).getByRole('button', { name: 'Zoom in', exact: true });
  await zoomOut.click(); await zoomOut.click();
  assert.equal(await zoomOut.isDisabled(), true);
  assert.equal(await controls(page).getByRole('button', { name: '50%', exact: true }).count(), 1);
  for (let step = 0; step < 14; step++) await zoomIn.click();
  assert.equal(await zoomIn.isDisabled(), true);
  await controls(page).getByRole('button', { name: '400%', exact: true }).click();
  assert.equal(await controls(page).getByRole('button', { name: '100%', exact: true }).count(), 1, 'the zoom label resets the zoom');
});

test('a diagram that cannot be drawn shows why, with its source', async t => {
  const page = await reply(t, '```mermaid\ngraph TD\n  A --> \n  ((( broken\n```\n');
  await page.getByText(/^Could not render diagram: /).waitFor();
  assert.match(await page.locator('.diagram-source').textContent(), /\(\(\( broken/);
  assert.equal(await page.locator('.diagram svg').count(), 0);
});

test('links and scripts in a diagram from a reply are removed', async t => {
  const page = await reply(t, '```mermaid\ngraph TD\n  A[Open me] --> B\n  click A href "javascript:window.opened=1"\n  click B href "https://example.com/tracking"\n```\n');
  const diagram = page.getByRole('region', { name: /^Diagram preview/ });
  await diagram.locator('svg').waitFor();
  assert.equal(await diagram.locator('a, script, foreignObject, [href], [onclick]').count(), 0);
  await diagram.getByText('Open me').dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.opened), undefined);
});
