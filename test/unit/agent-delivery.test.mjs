import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createComponent } from 'solid-js';
import { installDom, renderComponent } from '../dom.mjs';
import { Message } from '../../clients/ui/components/Message.tsx';
import { SessionLinkContext } from '../../clients/ui/lib/subagentNavigation.ts';

let dom, view;
beforeEach(() => { dom = installDom(); });
afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

/** A message from another chat, as the daemon delivers it. */
const delivered = content => ({ id: 'delivery', role: 'custom', customType: 'piop-agent-message', content, details: { notificationId: 'n1' } });

/** Renders the message with a session list that knows only chat-7 on the local host. */
function renderWithSessions(message, opened) {
  const links = { name: (hostId, sessionId) => hostId === 'local' && sessionId === 'chat-7' ? 'Build chat' : undefined, open: (hostId, sessionId) => opened.push([hostId, sessionId]) };
  return renderComponent(props => createComponent(SessionLinkContext.Provider, { value: links, get children() { return createComponent(Message, props); } }), { message });
}

test('a message from another chat shows a link to the sending session and its text as Markdown', async () => {
  const opened = [];
  view = await renderWithSessions(delivered(JSON.stringify({ notificationId: 'n1', sourceSessionId: 'chat-7', sourceHostId: 'local', message: 'Build is **green**' })), opened);
  const article = document.querySelector('[aria-label="Message from another agent"]');
  assert.equal(article.querySelector('strong').textContent, 'green');
  const link = article.querySelector('button.agent-delivery-source');
  assert.equal(link.textContent, 'Build chat');
  link.click();
  assert.deepEqual(opened, [['local', 'chat-7']]);
});

test('a message from an unlisted or unparsable source still shows its text', async () => {
  view = await renderWithSessions(delivered('plain words'), []);
  const article = document.querySelector('[aria-label="Message from another agent"]');
  assert.match(article.textContent, /plain words/);
  assert.equal(article.querySelector('.agent-delivery-source').textContent, 'Unknown session');
  assert.equal(article.querySelector('button.agent-delivery-source'), null);
});
