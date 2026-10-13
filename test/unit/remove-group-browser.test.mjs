import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('group removal blocks cancellation while pending and allows cancellation and retry after failure', async t => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  let reply = pending.promise;
  const page = await startupPage(t, 'production', {
    entryPoint: 'test/fixtures/remove-group-browser.tsx', ready: '[aria-label="Group state"]',
    prepare: page => page.exposeFunction('removeExampleGroup', () => { started.resolve(); return reply; }),
  });
  await page.getByRole('button', { name: 'Remove Work' }).click();
  await page.getByRole('button', { name: 'Forget group', exact: true }).click();
  await started.promise;
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Forgetting…', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  assert.equal(await page.getByLabel('Group state').textContent(), 'Work group');

  pending.resolve({ error: 'cannot save' });
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /cannot save/);
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Forget group', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('Group state').textContent(), 'Work group');

  reply = Promise.resolve({});
  await page.getByRole('button', { name: 'Remove Work' }).click();
  await page.getByRole('button', { name: 'Forget group', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('Group state').textContent(), 'Group removed');
});
