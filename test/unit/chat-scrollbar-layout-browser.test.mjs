import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('the chat layout does not move when the chat history scrollbar appears', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  const layout = () => page.evaluate(() => {
    const messages = document.querySelector('.messages');
    const box = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.right)]; };
    return { scrollbar: messages.scrollHeight > messages.clientHeight, conversation: box('.messages > .conversation'), composer: box('.composer') };
  });
  const seen = [];
  for (let index = 1; index <= 8 && !seen.at(-1)?.scrollbar; index++) {
    await composer.fill('Message ' + index + ' ' + 'words '.repeat(60));
    await composer.press('Enter');
    await page.getByText('Reply to Message ' + index).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
    seen.push(await layout());
  }
  assert.ok(seen.some(item => !item.scrollbar) && seen.at(-1).scrollbar, 'the chat must start without a scrollbar and end with one: ' + JSON.stringify(seen));
  assert.deepEqual(new Set(seen.map(item => JSON.stringify([item.conversation, item.composer]))).size, 1, JSON.stringify(seen));
});
