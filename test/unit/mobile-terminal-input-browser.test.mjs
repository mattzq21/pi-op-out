import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const open = async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/mobile-terminal-input-browser.tsx',
    ready: '[aria-label="Terminal command"]', holdStorage: false,
  });
  const sent = async () => JSON.parse(await page.getByLabel('Sent input').textContent());
  const commandIs = value => page.waitForFunction(text => document.querySelector('[aria-label="Terminal command"]').textContent === text, value);
  const emit = data => page.evaluate(value => window.emitShell(value), data);
  return { page, sent, commandIs, emit, command: page.getByRole('textbox', { name: 'Terminal command' }), send: page.getByRole('button', { name: 'Send', exact: true }) };
};

test('a late accepted mobile command keeps the command typed while it was pending', { timeout: 15000 }, async t => {
  const { page, command, send, sent } = await open(t);
  await command.fill('echo first');
  await command.press('Enter');
  assert.deepEqual(await sent(), ['echo first\r']);
  assert.equal(await send.isDisabled(), true);
  await command.fill('echo second');
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'echo second');
});

test('a late accepted mobile command does not touch the terminal the user switched to', { timeout: 15000 }, async t => {
  const { page, command, sent, commandIs } = await open(t);
  await command.fill('echo first');
  await command.press('Enter');
  assert.deepEqual(await sent(), ['echo first\r']);
  await page.getByRole('button', { name: 'Second' }).click();
  await commandIs('draft two');
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'draft two');
});

test('a rejected mobile command stays editable', { timeout: 15000 }, async t => {
  const { page, command, send, sent, commandIs } = await open(t);
  await command.fill('ehco typo');
  await command.press('Enter');
  assert.deepEqual(await sent(), ['ehco typo\r']);
  await page.getByRole('button', { name: 'Reject oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'ehco typo');
  await command.fill('echo fixed');
  await send.click();
  assert.deepEqual(await sent(), ['ehco typo\r', 'echo fixed\r']);
  await page.getByRole('button', { name: 'Accept oldest input' }).click();
  await commandIs('');
});

test('repeated Enter while a mobile command is pending sends it once and one corrected retry after rejection', { timeout: 15000 }, async t => {
  const { page, command, send, sent } = await open(t);
  await command.fill('ehco typo');
  await command.press('Enter');
  await command.press('Enter');
  await command.press('Enter');
  assert.deepEqual(await sent(), ['ehco typo\r']);
  assert.equal(await send.isDisabled(), true);
  await command.fill('echo fixed');
  await command.press('Enter');
  assert.deepEqual(await sent(), ['ehco typo\r']);
  await page.getByRole('button', { name: 'Reject oldest input' }).click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'echo fixed');
  await command.press('Enter');
  await command.press('Enter');
  assert.deepEqual(await sent(), ['ehco typo\r', 'echo fixed\r']);
});

test('a late accepted mobile interrupt keeps the newer draft', { timeout: 15000 }, async t => {
  const { page, command, send, sent, commandIs } = await open(t);
  const accept = page.getByRole('button', { name: 'Accept oldest input' });
  await command.fill('sleep 100');
  await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  assert.deepEqual(await sent(), ['\u0003']);
  await command.fill('echo after');
  await accept.click();
  await page.waitForFunction(() => !document.querySelector('.terminal-controls button').disabled);
  assert.equal(await command.textContent(), 'echo after');
  await send.click();
  assert.deepEqual(await sent(), ['\u0003', 'echo after\r']);
  await accept.click();
  await commandIs('');
});

test('switching mobile terminal tabs restores each unsent draft', { timeout: 15000 }, async t => {
  const { page, command, sent, commandIs } = await open(t);
  await command.fill('draft one');
  await page.getByRole('button', { name: 'Second' }).click();
  await commandIs('draft two');
  await page.getByRole('button', { name: 'Shell' }).click();
  await commandIs('draft one');
  await page.getByRole('button', { name: 'Second' }).click();
  await commandIs('draft two');
  assert.deepEqual(await sent(), []);
});

test('the control row has no left and right arrows, and keyboard arrows do not send keys', { timeout: 15000 }, async t => {
  const { page, command, sent } = await open(t);
  assert.equal(await page.getByRole('button', { name: '←', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '→', exact: true }).count(), 0);
  await command.fill('echo one');
  await command.press('ArrowUp');
  await command.press('ArrowDown');
  assert.equal(await command.textContent(), 'echo one');
  assert.deepEqual(await sent(), []);
});

test('the up button copies the shell history entry into the box, and Send runs the edited copy as a new command', { timeout: 15000 }, async t => {
  const { page, command, sent, commandIs, emit } = await open(t);
  await page.getByRole('button', { name: '↑', exact: true }).click();
  assert.deepEqual(await sent(), ['\u001b[A']);
  await emit('git status');
  await commandIs('git status');
  assert.equal(await page.getByLabel('Terminal output').textContent(), 'demo$ git status', 'the command shows once, in the box after the prompt');
  await command.fill('git status --short');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  assert.deepEqual(await sent(), ['\u001b[A', '\u001b>git status --short\r'], 'bash goes back to its empty line before the command');
});

test('up and down move through shell history and down past the newest entry restores the typed text', { timeout: 15000 }, async t => {
  const { page, command, sent, commandIs, emit } = await open(t);
  const up = page.getByRole('button', { name: '↑', exact: true });
  const down = page.getByRole('button', { name: '↓', exact: true });
  await command.fill('git pu');
  await up.click();
  await emit('echo one');
  await commandIs('echo one');
  await up.click();
  await emit('\b'.repeat(8) + 'ls\u001b[K');
  await commandIs('ls');
  await down.click();
  await emit('\b\becho one');
  await commandIs('echo one');
  await down.click();
  await emit('\r' + '\u001b[C'.repeat(6) + '\u001b[K');
  await commandIs('git pu');
  assert.deepEqual(await sent(), ['\u001b[A', '\u001b[A', '\u001b[B', '\u001b[B']);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  assert.equal((await sent()).at(-1), 'git pu\r', 'bash is already on its empty line');
});

test('the up button with no older command changes nothing', { timeout: 15000 }, async t => {
  const { page, command, sent, emit } = await open(t);
  await command.fill('git pu');
  await page.getByRole('button', { name: '↑', exact: true }).click();
  await emit('\u0007');
  await page.waitForFunction(() => document.querySelector('[aria-label="Terminal output"]').textContent === 'demo$ git pu');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  assert.deepEqual(await sent(), ['\u001b[A', 'git pu\r']);
  assert.equal(await command.textContent(), 'git pu');
});
