import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';

test('mobile users can queue a follow-up while the agent is streaming', async () => {
  const dom = installDom(); let view;
  globalThis.__PIOP_TEST_MODE__ = 'mobile';

  try {
    const { Composer } = await import('../../clients/ui/components/Composer.tsx');
    const sent = [];
    view = await renderComponent(Composer, { streaming: true, queued: 0, commands: [], agents: [], models: [], model: null, thinkingLevel: 'off', thinkingLevels: ['off'], onSend: async (...args) => sent.push(args), onPause() {}, onResume() {}, onAbort() {}, onAgent() {}, onModel() {}, onThinking() {}, onToggleFastMode() {} });
    await enterText(document.querySelector('[aria-label="Message piop"]'), 'After this, review the changes');
    const send = document.querySelector('[aria-label="Send message"]');
    assert.ok(send);
    await act(() => send.click());
    assert.equal(sent[0][1], 'followUp');
    assert.ok(document.querySelector('[aria-label="Pause piop"]'));
  } finally { await view?.unmount(); dom.restore(); delete globalThis.__PIOP_TEST_MODE__; }
});
