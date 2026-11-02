import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { appBrowser } from '../app-browser-fixture.mjs';

test('which subagent tool steps show subagent icons in the transcript', { timeout: 150000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Use every subagent tool');
  await composer.press('Enter');
  await page.locator('.tool-event', { hasText: 'stop_subagent' }).waitFor({ timeout: 90000 });
  await page.locator('.tool-event', { hasText: 'stop_subagent' }).locator('.tool-summary', { hasText: /Completed|Failed/ }).waitFor({ timeout: 30000 });
  if (process.env.PIOP_SCREENSHOTS) await page.screenshot({ path: join(process.env.PIOP_SCREENSHOTS, 'subagent-tools.png') });
  const steps = await page.locator('.tool-event').evaluateAll(rows => rows.map(row => {
    const timeline = row.nextElementSibling?.classList.contains('subagent-timeline') ? row.nextElementSibling : undefined;
    return [row.querySelector('.tool-summary strong')?.textContent ?? row.textContent.trim().split(/\s/)[0], [...timeline?.querySelectorAll('.subagent-name') ?? []].map(name => name.textContent).join(',')];
  }));
  assert.deepEqual(steps, [
    ['spawn_subagents', 'Solo'], ['await_subagents', 'Solo'],
    ['message_subagent', 'Solo'], ['await_subagents', 'Solo'],
    ['message_subagent', 'Solo'], ['message_subagent', 'Solo'],
    ['list_subagents', 'Solo'], ['stop_subagent', 'Solo'],
  ]);
});
