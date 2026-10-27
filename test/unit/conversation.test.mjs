import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent } from '../dom.mjs';
import { ChatView } from '../../clients/ui/components/ChatView.tsx';

describe('conversation behavior', () => {
  let dom, view, props;
  beforeEach(() => {
    dom = installDom();
    props = { readOnly: true, state: { model: null, thinkingLevel: 'off', isStreaming: false, messageCount: 0 }, messages: [], models: [], commands: [], thinkingLevels: [], widgets: [], statuses: {} };
  });
  afterEach(async () => { await view?.unmount(); view = undefined; dom.restore(); });

  async function render(extra = {}) {
    props = { ...props, ...extra };
    if (view) await view.rerender(props); else view = await renderComponent(ChatView, props);
  }

  const user = (id, content = 'Question', timestamp = 0) => ({ id, role: 'user', content, timestamp });
  const assistant = (id, content = 'Answer', extra = {}) => ({ id, role: 'assistant', content, ...extra });

test('work duration handles seconds, hours and unavailable timestamps', async () => {
    for (const [completedAt, expected] of [[0, 'Worked for 1s'], [60000, 'Worked for 1min'], [3600000, 'Worked for 1h'], [3660000, 'Worked for 1h 1min'], [-1, 'Work'], [undefined, 'Work']]) {
      await render({ messages: [user('u'), { id: 't', role: 'tool', content: 'result' }, assistant('a', 'Done', { completedAt })] });
      assert.equal(document.querySelector('.work-group summary').textContent, expected);
    }
  });

  test('a reply that stops without text can be forked from', async () => {
    await render({ onFork: () => {}, messages: [user('u'), assistant('w', [{ type: 'toolCall', id: 'c', name: 'ls', arguments: {} }], { stopReason: 'toolUse' }), { id: 't', role: 'toolResult', toolCallId: 'c', content: 'result' }, assistant('a', [{ type: 'thinking', thinking: 'Joke' }], { stopReason: 'stop' })] });
    assert.ok(document.querySelector('button[aria-label="Fork"]'));
    assert.equal(document.querySelector('.assistant-message .message-actions [aria-label^="Copy"]'), null);
  });

  test('a compaction after a finished turn shows outside its work group', async () => {
    await render({ messages: [user('u'), { id: 't', role: 'tool', content: 'result' }, assistant('a', 'Done'), { id: 'c', role: 'system', customType: 'compaction', content: 'Context compacted' }] });
    assert.equal(document.querySelector('.work-group-content'), null);
    assert.equal(document.querySelector('.command-result')?.textContent, 'Context compacted');
  });

});
