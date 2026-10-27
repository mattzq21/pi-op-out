import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

/**
 * The bundled agents have their own model, which this host cannot use, and Settings saves agents only when all of them are valid.
 * So they get the scripted model, which does not think, as a user sets it in Settings.
 */
async function bundledAgentsUseScriptedModel(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Local', exact: true }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  // The agent definitions load from an agent runtime.
  await page.getByRole('button', { name: 'workhorse', exact: true }).waitFor({ timeout: 30000 });
  for (const agent of ['workhorse', 'reviewer']) {
    await page.getByRole('button', { name: agent, exact: true }).click();
    await page.getByRole('button', { name: 'Agent default model', exact: true }).click();
    await page.getByRole('option', { name: /scripted-model/ }).click();
    await page.getByRole('combobox', { name: 'Agent default effort', exact: true }).selectOption('off');
  }
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
}

describe('cost and review at desktop and phone widths', { concurrency: 2 }, () => {
for (const width of [1280, 412]) test(`cost and review commands retain their full chat flow at width ${width}`, { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await bundledAgentsUseScriptedModel(page);
  await page.setViewportSize({ width, height: 900 });
  // The conversation list stays open from the desktop width; on a phone it covers the chat until the user taps beside it.
  if (width < 600) await page.getByRole('button', { name: 'Close conversations', exact: true }).click({ position: { x: width - 10, y: 450 } });
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
  // Its close button shows while the pointer is over the tab.
  await page.getByRole('tab', { name: 'Review README.md' }).hover();
  await page.getByRole('button', { name: 'Close Review README.md' }).click();
  await review.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Open review', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open review', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
});
});
