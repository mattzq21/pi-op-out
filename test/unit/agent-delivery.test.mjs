import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { installDom, renderComponent } from '../dom.mjs';
import { Message } from '../../clients/ui/components/Message.tsx';

let dom, view;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

/** A message from another chat, as the daemon delivers it. */
const delivered = content => ({ id: 'delivery', role: 'custom', customType: 'piop-agent-message', content, details: { notificationId: 'n1' } });

test('a message from another chat shows who sent it and its text as Markdown', async () => {
  view = await renderComponent(Message, { message: delivered(JSON.stringify({ notificationId: 'n1', sourceSessionId: 'chat-7', sourceHostId: 'local', message: 'Build is **green**' })) });
  const article = document.querySelector('[aria-label="Message from another agent"]');
  assert.equal(article.querySelector('small').textContent, 'Agent message · local/chat-7');
  assert.equal(article.querySelector('strong').textContent, 'green');
});

test('a message from another chat that is not in the expected form still shows its text', async () => {
  view = await renderComponent(Message, { message: delivered('plain words') });
  const article = document.querySelector('[aria-label="Message from another agent"]');
  assert.match(article.textContent, /plain words/);
  assert.match(article.querySelector('small').textContent, /unknown/);
});
