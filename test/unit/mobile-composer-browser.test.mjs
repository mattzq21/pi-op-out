import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';
import { testBrowserName } from '../test-browser.mjs';

const mobilePage = t => startupPage(t, 'mobile', {
    entryPoint: 'test/fixtures/mobile-composer-browser.tsx', ready: '[aria-label="Message piop"]', holdStorage: false,
    prepare: page => page.setViewportSize({ width: 412, height: 915 }),
  });
const sent = async page => JSON.parse(await page.getByLabel('Sent messages', { exact: true }).textContent());

test('mobile users can queue a follow-up while the agent is streaming', async t => {
  const page = await mobilePage(t);
  await page.getByRole('textbox', { name: 'Message piop', exact: true }).fill('After this, review the changes');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  assert.deepEqual(await sent(page), [
    { message: 'After this, review the changes', behavior: 'followUp', images: [] },
  ]);
  assert.equal(await page.getByRole('button', { name: 'Stop piop', exact: true }).isVisible(), true);
});

test('on mobile the keyboard Enter key starts a new line and only Send queues the message', async t => {
  const page = await mobilePage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.click();
  await page.keyboard.type('Check the logs');
  await page.keyboard.press('Enter');
  await page.keyboard.type('then fix the test');
  assert.deepEqual(await sent(page), []);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  assert.deepEqual(await sent(page), [
    { message: 'Check the logs\nthen fix the test', behavior: 'followUp', images: [] },
  ]);
});

async function typeAndCompose(page, text) {
  if (testBrowserName === 'webkit') {
    await page.keyboard.type(text);
    await page.keyboard.press('Control+Shift+u');
    await page.keyboard.type('cafe');
    return 'ucafe';
  }
  const keyboard = await page.context().newCDPSession(page);
  try {
    await keyboard.send('Input.insertText', { text });
    await keyboard.send('Input.imeSetComposition', { text: 'tests', selectionStart: 5, selectionEnd: 5 });
  } finally { await keyboard.detach(); }
  return 'tests';
}

test('tapping Send on mobile includes the word the keyboard is still composing and clears the editor', async t => {
  const page = await mobilePage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await editor.click();
  await editor.evaluate(node => node.addEventListener('compositionend', event => { window.composedAtSend = event.data; }, { once: true }));
  const word = await typeAndCompose(page, 'Please review ');
  assert.equal(await page.evaluate(() => window.composedAtSend), undefined);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByLabel('Sent messages', { exact: true }).filter({ hasText: 'Please review' }).waitFor();
  assert.equal(await page.evaluate(() => window.composedAtSend), word);
  assert.deepEqual(await sent(page), [{ message: 'Please review ' + word, behavior: 'followUp', images: [] }]);
  assert.equal(await editor.inputValue(), '');
});
