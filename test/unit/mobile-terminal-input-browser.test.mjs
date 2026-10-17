import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('a late accepted mobile command keeps the command typed while it was pending', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await command.fill('echo first');
  await command.press('Enter');
  assert.equal(await page.getByLabel('Sent input').textContent(), '["echo first\\r"]');
  assert.equal(await send.isDisabled(), true);
  await command.fill('echo second');
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'echo second');
});

test('a late accepted mobile command does not touch the terminal the user switched to', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  await command.fill('echo first');
  await command.press('Enter');
  assert.equal(await page.getByLabel('Sent input').textContent(), '["echo first\\r"]');
  await page.getByRole('button', { name: 'Second' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Terminal command"]').textContent === 'draft two');
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'draft two');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'draft two');
});
