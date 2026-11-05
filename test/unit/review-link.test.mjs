import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createComponent } from 'solid-js';
import { act, installDom, renderComponent } from '../dom.mjs';
import { ReviewLink } from '../../plugins/review/client/ReviewLink.tsx';
import { AuxiliaryChatsContext } from '../../clients/ui/lib/auxiliaryChats.ts';
import { PluginMessageContext } from '../../clients/ui/plugins/messages.ts';

let dom, view;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

async function render(current, listed) {
  const opened = [];
  const chats = { listed: (hostId, sessionId) => hostId === 'local' && sessionId === 'review-1' && listed, open: (hostId, sessionId) => opened.push(`${hostId}:${sessionId}`) };
  view = await renderComponent(() => createComponent(AuxiliaryChatsContext.Provider, { value: chats, get children() {
    return createComponent(PluginMessageContext.Provider, { value: { sessionId: () => current, command: async () => { throw new Error('No command expected'); } }, get children() {
      return createComponent(ReviewLink, { details: { sessionId: 'review-1', parentSessionId: 'chat-1', hostId: 'local' } });
    } });
  } }));
  return { opened, button: () => document.querySelector('.command-result button'), text: () => document.querySelector('.command-result').textContent };
}

test('a review link opens its review in the side pane', async () => {
  const { opened, button, text } = await render('chat-1', true);
  assert.doesNotMatch(text(), /archived/);
  await act(async () => button().click());
  assert.deepEqual(opened, ['local:review-1']);
});

test('the link of an archived review says so and has a disabled button', async () => {
  const { opened, button, text } = await render('chat-1', false);
  assert.match(text(), /Review archived/);
  assert.equal(button().disabled, true);
  await act(async () => button().click());
  assert.deepEqual(opened, []);
});

test('in a fork, the review link says the review belongs to the original chat and opens nothing', async () => {
  const { opened, button, text } = await render('fork-1', true);
  assert.equal(button(), null);
  assert.match(text(), /Code review belongs to the original conversation\./);
  assert.deepEqual(opened, []);
});
