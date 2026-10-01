import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent } from 'solid-js';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { ConversationQuestions, ConversationQuestionsContext, createConversationQuestions } from '../../src/components/ConversationQuestions.tsx';

test('question progress and typed answers survive switching conversations', async () => {
  const dom = installDom(); let view;
  const sent = []; const first = { command: async response => sent.push(response) }; const second = {};

  const request = { id: 'question', method: 'input', title: '__piop_request_user_input__', placeholder: JSON.stringify({ questions: [
    { id: 'one', header: 'First', question: 'Choose one', options: [{ label: 'Yes', description: '' }] },
    { id: 'two', header: 'Second', question: 'Explain', options: [] },
  ] }) };

  const item = { request, transport: first, owner: 'agent', queueId: 'queued' };

  function Questions(props) {
    const context = createConversationQuestions(() => [item], () => {});

    return createComponent(ConversationQuestionsContext.Provider, { value: context,
      get children() { return createComponent(ConversationQuestions, { get transport() { return props.transport; } }); },
    });
  }

  try {
    view = await renderComponent(Questions, { transport: first });
    await act(() => document.querySelector('.ask-user-option').click());
    await enterText(document.querySelector('[aria-label="Your response"]'), 'Keep this answer');
    await view.rerender({ transport: second });
    assert.equal(document.querySelector('.ask-user-dialog'), null);
    await view.rerender({ transport: first });
    assert.equal(document.querySelector('.ask-user-progress').textContent, '2 of 2');
    assert.equal(document.querySelector('[aria-label="Your response"]').value, 'Keep this answer');
    await act(() => document.querySelector('.ask-user-send').click());
    assert.deepEqual(JSON.parse(sent[0].value).answers, { one: { answers: ['Yes'] }, two: { answers: ['Keep this answer'] } });
  } finally { await view?.unmount(); dom.restore(); }
});
