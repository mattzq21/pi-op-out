import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createComponent } from 'solid-js';
import { act, installDom, renderComponent, untilDom } from '../dom.mjs';
import { ReviewLink } from '../../clients/ui/plugins/review/ReviewLink.tsx';

import { PluginMessageContext } from '../../clients/ui/plugins/messages.ts';

let dom, view;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

/** A review link as the daemon saves it, shown in the chat with sessionId current. */
async function render(current, open) {
  const opened = [];
  view = await renderComponent(() => createComponent(PluginMessageContext.Provider, { value: { sessionId: () => current, command: async command => { assert.equal(command.type, 'open_review'); opened.push(command.reviewId); await open?.(command.reviewId); } }, get children() {
    return createComponent(ReviewLink, { details: { sessionId: 'review-1', parentSessionId: 'chat-1' } });
  } }));
  return { opened, button: () => document.querySelector('.command-result button') };
}

test('a review link opens its review in the chat that started it', async () => {
  const { opened, button } = await render('chat-1');
  await act(async () => button().click());
  assert.deepEqual(opened, ['review-1']);
});

test('in a fork, the review link says the review belongs to the original chat and opens nothing', async () => {
  const { opened, button } = await render('fork-1');
  assert.equal(button(), null);
  assert.match(document.querySelector('.command-result').textContent, /Code review belongs to the original conversation\./);
  assert.deepEqual(opened, []);
});

test('a review that cannot open says why, and the link works again', async () => {
  let fail = true;
  const { opened, button } = await render('chat-1', () => { if (fail) throw new Error('The review chat was deleted'); });
  await act(async () => button().click());
  assert.equal((await untilDom(() => document.querySelector('[role="alert"]'))).textContent, 'The review chat was deleted');
  fail = false;
  await act(async () => button().click());
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.deepEqual(opened, ['review-1', 'review-1']);
});
