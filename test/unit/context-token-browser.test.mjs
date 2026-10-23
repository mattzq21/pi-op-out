import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('the context wheel shows its token count on click and hides it on Escape, an outside click, or scrolling', async t => {
  const page = await startupPage(t, 'development', { entryPoint: 'test/fixtures/context-token-browser.tsx', ready: 'main', holdStorage: false });
  const wheel = page.getByRole('button', { name: '123,456 tokens' });
  const tip = page.getByRole('tooltip');
  await wheel.click();
  assert.equal(await tip.textContent(), '123,456 tokens');
  assert.equal(await wheel.getAttribute('aria-describedby'), await tip.getAttribute('id'));
  await page.keyboard.press('Escape');
  assert.equal(await tip.count(), 0);

  await wheel.click();
  await page.getByRole('button', { name: 'Elsewhere' }).click();
  assert.equal(await tip.count(), 0, 'an outside click hides it');

  await wheel.click();
  await wheel.click();
  assert.equal(await tip.count(), 0, 'a second click hides it');

  await wheel.click();
  // The chat scrolls inside its own container, which does not bubble a scroll event.
  await page.locator('main').evaluate(main => main.dispatchEvent(new Event('scroll')));
  await tip.waitFor({ state: 'detached' });
});
