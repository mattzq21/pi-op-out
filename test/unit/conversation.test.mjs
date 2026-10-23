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

});
