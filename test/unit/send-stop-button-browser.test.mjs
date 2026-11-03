import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('a quick second click on Send does not stop the reply', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Message 1'); await composer.press('Enter');
  await page.getByText('Reply to Message 1').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => { window.sendButton = document.querySelector('.send-stop'); });
  await composer.fill('Slow 2');
  const box = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.working-dots').waitFor();
  const sameNode = await page.evaluate(() => window.sendButton === document.querySelector('.send-stop') && window.sendButton.classList.contains('stop-compact'));
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Stop piop', exact: true }).click();
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
  assert.deepEqual({ sameNode, replied: await page.getByText('Reply to Slow 2').count() }, { sameNode: true, replied: 0 });
});

test('Send turns straight into a working Stop', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Slow 1');
  await page.evaluate(() => { const button = document.querySelector('.send-stop'); window.states = []; new MutationObserver(() => window.states.push(`${button.classList.contains('stop-compact') ? 'stop' : 'send'}${button.disabled ? ' disabled' : ''}`)).observe(button, { attributes: true }); });
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Stop piop', exact: true }).click();
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
  const states = await page.evaluate(() => window.states);
  await composer.fill('Message 2'); await composer.press('Enter');
  await page.getByText('Reply to Message 2').waitFor({ timeout: 30000 });
  assert.deepEqual({ first: states[0], replied: await page.getByText('Reply to Slow 1').count() }, { first: 'stop', replied: 0 });
});
