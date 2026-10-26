import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

describe('cost and review at desktop and phone widths', { concurrency: 2 }, () => {
for (const width of [1280, 412]) test(`cost and review commands retain their full chat flow at width ${width}`, { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.setViewportSize({ width, height: 900 });
  if (width < 600) await page.getByRole('button', { name: 'Toggle conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Check plugin behavior');
  await composer.press('Enter');
  await page.getByText('Reply to Check plugin behavior', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await composer.fill('/cost 5');
  await composer.press('Enter');
  await page.getByText('Session cost limit set to $5.00 (API prices). Spent so far: $0.00.', { exact: true }).waitFor();
  await composer.fill('/cost clear');
  await composer.press('Enter');
  await page.getByText('Session cost limit cleared.', { exact: true }).waitFor();
  await composer.fill('/review README.md');
  await composer.press('Enter');
  const review = page.getByRole('region', { name: 'Side chat: Review README.md' });
  await review.waitFor({ timeout: 30000 });
  await review.getByText(/Reply to You are the dedicated code review agent/s).waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('tab', { name: 'Review README.md' }).getAttribute('aria-selected'), 'true');
  // Closing a review tab archives the review.
  await page.getByRole('button', { name: 'Close Review README.md' }).click();
  await review.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Open review', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open review', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
});
});
