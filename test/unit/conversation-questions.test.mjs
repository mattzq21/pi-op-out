import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent, createSignal } from 'solid-js';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { ConversationQuestions, ConversationQuestionsContext, createConversationQuestions } from '../../clients/ui/components/ConversationQuestions.tsx';

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

test('answers kept after a rejected send are sent again on retry once the dialog is rebuilt', { timeout: 15000 }, async () => {
  const dom = installDom(); let view;
  const sent = []; let reject = true;
  const first = { command: async response => { if (reject) throw new Error('Agent unreachable'); sent.push(response); } }; const second = {};

  const request = { id: 'question', method: 'input', title: '__piop_request_user_input__', placeholder: JSON.stringify({ questions: [
    { id: 'one', header: 'First', question: 'Choose one', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
    { id: 'two', header: 'Second', question: 'Explain', options: [] },
  ] }) };

  const removed = [];

  function Questions(props) {
    const [items, setItems] = createSignal([{ request, transport: first, owner: 'agent', queueId: 'queued' }]);
    const context = createConversationQuestions(items, item => { removed.push(item.queueId); setItems(current => current.filter(entry => entry !== item)); });

    return createComponent(ConversationQuestionsContext.Provider, { value: context,
      get children() { return createComponent(ConversationQuestions, { get transport() { return props.transport; } }); },
    });
  }

  try {
    view = await renderComponent(Questions, { transport: first });
    await act(() => document.querySelectorAll('.ask-user-option')[1].click());
    await enterText(document.querySelector('[aria-label="Your response"]'), 'Because of the failure');
    await act(() => document.querySelector('.ask-user-send').click());
    assert.equal(document.querySelector('.ask-user-dialog [role="alert"]').textContent, 'Agent unreachable');
    assert.deepEqual(removed, []);

    await view.rerender({ transport: second });
    await view.rerender({ transport: first });
    assert.equal(document.querySelector('.ask-user-progress').textContent, '2 of 2');
    assert.equal(document.querySelector('[aria-label="Your response"]').value, 'Because of the failure');

    reject = false;
    await act(() => document.querySelector('.ask-user-send').click());
    assert.deepEqual(JSON.parse(sent[0].value).answers, { one: { answers: ['No'] }, two: { answers: ['Because of the failure'] } });
    assert.deepEqual(removed, ['queued']);
    assert.equal(document.querySelector('.ask-user-dialog'), null);
  } finally { await view?.unmount(); dom.restore(); }
});

test('question drafts with the same request id in different chats stay separate when one is sent', { timeout: 15000 }, async () => {
  const dom = installDom(); let view;
  const firstSent = []; const secondSent = [];
  const first = { command: async response => firstSent.push(response) }; const second = { command: async response => secondSent.push(response) };

  const request = { id: 'question', method: 'input', title: '__piop_request_user_input__', placeholder: JSON.stringify({ questions: [
    { id: 'reason', header: 'Reason', question: 'Explain', options: [] },
  ] }) };

  const removed = [];

  function Questions(props) {
    const [items, setItems] = createSignal([
      { request, transport: first, owner: 'agent', queueId: 'first-queue' },
      { request, transport: second, owner: 'agent', queueId: 'second-queue' },
    ]);
    const context = createConversationQuestions(items, item => { removed.push(item.queueId); setItems(current => current.filter(entry => entry !== item)); });

    return createComponent(ConversationQuestionsContext.Provider, { value: context,
      get children() { return createComponent(ConversationQuestions, { get transport() { return props.transport; } }); },
    });
  }

  try {
    view = await renderComponent(Questions, { transport: first });
    await enterText(document.querySelector('[aria-label="Your response"]'), 'First chat answer');
    await view.rerender({ transport: second });
    assert.equal(document.querySelector('[aria-label="Your response"]').value, '');
    await enterText(document.querySelector('[aria-label="Your response"]'), 'Second chat answer');

    await view.rerender({ transport: first });
    assert.equal(document.querySelector('[aria-label="Your response"]').value, 'First chat answer');
    await act(() => document.querySelector('.ask-user-send').click());
    assert.equal(firstSent.length, 1);
    assert.equal(firstSent[0].id, 'question');
    assert.deepEqual(JSON.parse(firstSent[0].value).answers, { reason: { answers: ['First chat answer'] } });
    assert.deepEqual(secondSent, []);
    assert.deepEqual(removed, ['first-queue']);
    assert.equal(document.querySelector('.ask-user-dialog'), null);

    await view.rerender({ transport: second });
    assert.equal(document.querySelector('[aria-label="Your response"]').value, 'Second chat answer');
    await act(() => document.querySelector('.ask-user-send').click());
    assert.equal(firstSent.length, 1);
    assert.equal(secondSent.length, 1);
    assert.equal(secondSent[0].id, 'question');
    assert.deepEqual(JSON.parse(secondSent[0].value).answers, { reason: { answers: ['Second chat answer'] } });
    assert.deepEqual(removed, ['first-queue', 'second-queue']);
    assert.equal(document.querySelector('.ask-user-dialog'), null);
  } finally { await view?.unmount(); dom.restore(); }
});
