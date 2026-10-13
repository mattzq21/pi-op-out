import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('mobile users can queue a follow-up while the agent is streaming', async t => {
  const page = await startupPage(t, 'mobile', {
    entryPoint: 'test/fixtures/mobile-composer-browser.tsx', ready: '[aria-label="Message piop"]', holdStorage: false,
    prepare: page => page.setViewportSize({ width: 412, height: 915 }),
  });
  await page.getByRole('textbox', { name: 'Message piop', exact: true }).fill('After this, review the changes');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Sent messages', { exact: true }).textContent()), [
    { message: 'After this, review the changes', behavior: 'followUp', images: [] },
  ]);
  assert.equal(await page.getByRole('button', { name: 'Pause piop', exact: true }).isVisible(), true);
});
