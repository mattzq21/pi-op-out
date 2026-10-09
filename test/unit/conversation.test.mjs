import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

describe('conversation behavior', () => {
  let dom, view, props;
  beforeEach(() => {
    dom = installDom();
    props = { readOnly: false, state: { isStreaming: false, messageCount: 0 }, messages: [], models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {}, onSend: async () => {}, onBranch: () => {} };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });

  async function render(extra = {}) { props = { ...props, ...extra, state: { model: null, thinkingLevel: 'off', isStreaming: false, messageCount: 0, ...(extra.state ?? props.state) } };

  if (view) await view.rerender(props); else view = await renderComponent(ChatView, props); }

  const user = (id, content = 'Question', timestamp = 0) => ({ id, role: 'user', content, timestamp });
  const assistant = (id, content = 'Answer', extra = {}) => ({ id, role: 'assistant', content, ...extra });
  const retryButton = () => document.querySelector('.message-failure button');
  const click = async element => act(async () => element.click());

  test('settled turns compact repeated tools and separate reasoning from the final answer', async () => {
    const messages = [user('u'), assistant('call', [{ type: 'toolCall', name: 'read' }]), { id: 't1', role: 'tool', toolName: 'read', content: 'one' }, { id: 't2', role: 'tool', toolName: 'read', content: 'two' }, assistant('a', [{ type: 'thinking', thinking: 'Consider the evidence' }, { type: 'text', text: 'Final answer' }], { completedAt: 61000 }), { id: 's', role: 'system', content: 'Saved' }];
    await render({ messages });
    assert.equal(document.querySelectorAll('.conversation-turn').length, 1);
    assert.equal(document.querySelector('.work-group').open, false);
    assert.equal(document.querySelector('.work-group-content'), null);
    await act(() => { const group = document.querySelector('.work-group'); group.open = true; group.dispatchEvent(new Event('toggle')); });
    assert.match(document.querySelector('.work-group').textContent, /Worked for 1min 1s.*read x2.*Consider the evidence/s);
    assert.doesNotMatch(document.querySelector('.work-group').textContent, /Final answer/);
    assert.equal(document.querySelectorAll('.assistant-message').length, 2);
    assert.equal(document.querySelector('[role=status]').textContent, 'Saved');
    await render({ debug: true });
    await act(() => { const group = document.querySelector('.work-group'); group.open = true; group.dispatchEvent(new Event('toggle')); });
    await act(() => { for (const details of document.querySelectorAll('details.tool-event')) { details.open = true; details.dispatchEvent(new Event('toggle')); } });
    assert.equal(document.querySelectorAll('[aria-label="Tool output"]').length, 2);
    assert.doesNotMatch(document.body.textContent, /read x2/);
  });

  test('user prompts start turns, with only the latest turn remaining active or paused', async () => {
    const messages = [user('u'), assistant('a'), user('u2', 'Next'), assistant('a2', '', { stopReason: 'aborted' })];
    await render({ messages, state: { isStreaming: true, viewers: 2 } });
    assert.equal(document.querySelectorAll('.conversation-turn').length, 2);
    assert.equal(document.querySelectorAll('.active-work-content').length, 1);
    await render({ state: { isPaused: true } });
    assert.match(document.querySelector('.active-work-content').textContent, /Response paused/);
    assert.equal(retryButton(), null);
    await render({ state: {} }); assert.ok(retryButton());
  });

  test('work duration handles seconds, hours and unavailable timestamps', async () => {
    for (const [completedAt, expected] of [[0, 'Worked for 1s'], [60000, 'Worked for 1min'], [3600000, 'Worked for 1h'], [3660000, 'Worked for 1h 1min'], [-1, 'Work'], [undefined, 'Work']]) {
      await render({ messages: [user('u'), { id: 't', role: 'tool', content: 'result' }, assistant('a', 'Done', { completedAt })] });
      assert.equal(document.querySelector('.work-group summary').textContent, expected);
    }
  });

  test('retry resends attachments once, consumes the matching draft, and restores it after rejection', async () => {
    const image = { type: 'image', mimeType: 'image/png', data: 'aA==' };
    const pending = Promise.withResolvers(); const calls = [], drafts = [];
    await render({ messages: [user('u', [{ type: 'text', text: 'Question' }, image]), assistant('a', '', { stopReason: 'aborted' })], draft: 'Question', onDraftChange: value => drafts.push(value), onSend: (...args) => { calls.push(args);

    return pending.promise; } });
    await act(async () => { retryButton().click(); retryButton().click(); });
    assert.deepEqual(calls, [['Question', undefined, [image]]]); assert.deepEqual(drafts, ['']); assert.equal(retryButton().disabled, true);
    await render({ draft: '' });
    await act(async () => pending.reject(new Error('offline')));
    assert.deepEqual(drafts, ['', 'Question']); assert.equal(document.querySelector('.retry-error').textContent, 'Retry failed: offline'); assert.equal(retryButton().disabled, false);
    const second = Promise.withResolvers();
    await render({ draft: 'Question', onSend: () => second.promise });
    await act(async () => retryButton().click());
    await render({ draft: '' });
    await act(async () => second.resolve(false));
    assert.equal(document.querySelector('.retry-error'), null); assert.deepEqual(drafts, ['', 'Question', '', 'Question']);
  });

  test('failed retries preserve a newly edited draft and memoized turns use current callbacks', async () => {
    const pending = Promise.withResolvers(); const drafts = [], branches = [];
    const messages = [user('u'), assistant('a', 'Partial answer', { stopReason: 'aborted' })];
    await render({ messages, draft: 'Question', onDraftChange: value => drafts.push(value), onSend: () => pending.promise, onBranch: () => branches.push('old') });
    await act(async () => retryButton().click());
    await render({ draft: 'New question', onBranch: message => branches.push(message.id) });
    await act(async () => pending.resolve(false)); assert.deepEqual(drafts, ['']);
    await act(async () => document.querySelector('[aria-label="Fork"]').click());
    assert.deepEqual(branches, ['a']);
  });

  test('MCP loading hides the empty state and validates debug server names', async () => {
    props.readOnly = true;
    await render(); assert.ok(document.querySelector('.empty-chat')); assert.equal(document.querySelector('.composer-stack'), null);
    await render({ statuses: { 'pi-desktop-mcp-loading': 'Loading database' } }); assert.equal(document.querySelector('.empty-chat'), null); assert.match(document.body.textContent, /Loading MCPs/);
    await render({ debug: true }); assert.match(document.body.textContent, /Loading database/);
    await render({ statuses: { 'pi-desktop-mcp-loading': 'json:[{"id":"a","name":"search"},null,{"id":2,"name":"invalid"}]' } }); assert.equal(document.querySelector('.mcp-loading-list').textContent, 'Loading search');

    for (const value of ['json:{broken', 'json:{}']) { await render({ statuses: { 'pi-desktop-mcp-loading': value } }); assert.equal(document.querySelector('.mcp-loading-list').textContent, ''); }
  });

  test('scrolling upward suspends automatic following until the user returns to the bottom', async () => {
    await render({ messages: [user('u')] }); const scroller = document.querySelector('.messages');
    Object.defineProperties(scroller, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200 } });
    await render({ messages: [user('u'), assistant('a')] }); assert.equal(document.querySelector('.messages'), scroller, 'message scroller must survive rerenders'); assert.equal(scroller.scrollTop, 1000);
    await act(async () => scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })));
    scroller.scrollTop = 300; await act(async () => scroller.dispatchEvent(new Event('scroll')));
    await render({ messages: [user('u'), assistant('a', 'More output')] }); assert.equal(scroller.scrollTop, 300);
    scroller.scrollTop = 800; await act(async () => scroller.dispatchEvent(new Event('scroll')));
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200 });
    await render({ messages: [user('u'), assistant('a', 'Latest output')] }); assert.equal(scroller.scrollTop, 1200);
  });




  test('editable chat shows project actions, extension activity and the submitted message while MCP loads', async () => {
    let opened = 0, cleared = 0; const pending = Promise.withResolvers();
    await render({ readOnly: false, projectCwd: '/repo/project', onOpenProject: () => opened++, onClearProject: () => cleared++, widgets: ['widget'], statuses: { visible: 'Ready', 'pi-desktop-hook-stats': 'legacy hook payload' }, state: { messageCount: 0, activity: 'Preparing' }, draft: 'Question', onSend: () => pending.promise });
    await click(document.querySelector('[aria-label="Selected project: project"]')); await click(document.querySelector('[aria-label="Clear project"]')); assert.equal(opened, 1); assert.equal(cleared, 1);
    assert.equal(document.querySelector('.extension-widget').textContent, 'widget'); assert.equal(document.querySelector('.runtime-activity').textContent, 'Preparing');
    await render({ statuses: { 'pi-desktop-mcp-loading': 'Loading server' } }); assert.equal(document.querySelector('.runtime-activity'), null);
    await click(document.querySelector('[aria-label="Send message"]')); assert.equal(document.querySelector('.mcp-pending-message').textContent.trim(), 'Question');
    await act(async () => pending.resolve()); assert.equal(document.querySelector('.mcp-pending-message'), null);
  });
});
