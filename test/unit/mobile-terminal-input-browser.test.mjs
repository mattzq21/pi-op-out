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

test('a rejected mobile command stays editable and stays out of history', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await command.fill('ehco typo');
  await command.press('Enter');
  assert.equal(await page.getByLabel('Sent input').textContent(), '["ehco typo\\r"]');
  await page.getByRole('button', { name: 'Reject oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'ehco typo');
  await command.fill('echo fixed');
  await send.click();
  assert.equal(await page.getByLabel('Sent input').textContent(), '["ehco typo\\r","echo fixed\\r"]');
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Terminal command"]').textContent === '');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'echo fixed');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'echo fixed');
});

test('repeated Enter while a mobile command is pending sends it once and one corrected retry after rejection', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const sentInput = page.getByLabel('Sent input');
  await command.fill('ehco typo');
  await command.press('Enter');
  await command.press('Enter');
  await command.press('Enter');
  assert.equal(await sentInput.textContent(), '["ehco typo\\r"]');
  assert.equal(await send.isDisabled(), true);
  await command.fill('echo fixed');
  await command.press('Enter');
  assert.equal(await sentInput.textContent(), '["ehco typo\\r"]');
  await page.getByRole('button', { name: 'Reject oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'echo fixed');
  await command.press('Enter');
  await command.press('Enter');
  assert.equal(await sentInput.textContent(), '["ehco typo\\r","echo fixed\\r"]');
});

test('a late accepted mobile interrupt keeps the newer draft and stays out of history', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const accept = page.getByRole('button', { name: 'Accept oldest input' });
  await command.fill('sleep 100');
  await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  assert.equal(await page.getByLabel('Sent input').textContent(), '["\\u0003"]');
  await command.fill('echo after');
  await accept.click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'echo after');
  await send.click();
  assert.equal(await page.getByLabel('Sent input').textContent(), '["\\u0003","echo after\\r"]');
  await accept.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Terminal command"]').textContent === '');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'echo after');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'echo after');
});

test('switching mobile terminal tabs isolates command history and restores each unsent draft', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const commandIs = value => page.waitForFunction(text => document.querySelector('[aria-label="Terminal command"]').textContent === text, value);
  await command.fill('echo first');
  await command.press('Enter');
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await commandIs('');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'echo first');
  await command.press('ArrowDown');
  assert.equal(await command.textContent(), '');
  await command.fill('draft one');
  await page.getByRole('button', { name: 'Second' }).click();
  await commandIs('draft two');
  await command.press('ArrowUp');
  assert.equal(await command.textContent(), 'draft two');
  await page.getByRole('button', { name: 'Shell' }).click();
  await commandIs('draft one');
  await page.getByRole('button', { name: 'Second' }).click();
  await commandIs('draft two');
  assert.equal(await page.getByLabel('Sent input').textContent(), '["echo first\\r"]');
});
