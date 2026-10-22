import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { installDom } from '../dom.mjs';
import { DraftRuntime, clearDraftCatalogs } from '../../clients/ui/lib/draftRuntime.ts';
import { decodeAgentValue } from '../../clients/ui/lib/agentProtocol.ts';

const agent = (name, extra = {}) => ({ name, model: '', effort: '', path_systemprompt: 'prompt.md', path_agent_prompt: '', tools: [], skills: [], mcpServers: {}, ...extra });
const models = [{ provider: 'p', id: 'plain' }, { provider: 'p', id: 'fast' }];
const generalDefault = { agents: [agent('general', { isDefault: true, model: 'p/plain' }), agent('chosen', { model: 'p/fast', effort: 'low', fastMode: true }), agent('bare')] };
const chosenDefault = { agents: [agent('general', { model: 'p/plain' }), agent('chosen', { isDefault: true, model: 'p/fast', effort: 'low', fastMode: true })] };

/** A draft on a host whose agent definitions the test can change. */
function hostDraft(t) {
  const dom = installDom();
  const host = { config: generalDefault };
  t.after(() => { clearMocks(); clearDraftCatalogs(); dom.restore(); });
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    assert.equal(args.args.request.action, 'draft_catalog');
    return { config: structuredClone(host.config), models, commands: [], commandDetails: [] };
  });
  const events = [];
  const draft = new DraftRuntime(() => 'local', event => events.push(event));
  const shown = () => decodeAgentValue(events.filter(event => event.statusKey === 'pi-define-agents').at(-1).statusText.slice(5)).active;
  /** Changes the host's default agent and reloads the definitions, as Settings does after a save. */
  const changeDefault = async () => { host.config = chosenDefault; clearDraftCatalogs(); await draft.reload(() => true); };
  return { draft, shown, changeDefault };
}

test('a draft records the default agent it shows, so sending starts that agent even after the host default changes', async t => {
  const { draft, shown } = hostDraft(t);
  await draft.applyDefaults('medium', false);
  assert.equal(shown(), 'general');
  assert.deepEqual([...draft.changes.values()], [{ type: 'select_agent', agent: 'general' }]);
});

test('an unchanged draft shows the new default agent with its model, thinking level and fast mode after a reload', async t => {
  const { draft, shown, changeDefault } = hostDraft(t);
  await draft.applyDefaults('medium', false);
  await changeDefault();
  assert.equal(shown(), 'chosen');
  assert.deepEqual([...draft.changes.values()], [{ type: 'select_agent', agent: 'chosen' }]);
  const state = await draft.command({ type: 'get_state' });
  assert.deepEqual([state.model?.id, state.thinkingLevel, draft.fastMode], ['fast', 'low', true]);
});

test('choosing an agent without its own model or effort starts the chat with the model and effort the composer shows', async t => {
  const { draft } = hostDraft(t);
  await draft.applyDefaults('medium', false);
  await draft.command({ type: 'select_agent', agent: 'general' });
  await draft.command({ type: 'select_agent', agent: 'bare' });
  const state = await draft.command({ type: 'get_state' });
  assert.equal(state.model?.id, 'plain');
  assert.deepEqual([...draft.changes.values()], [{ type: 'select_agent', agent: 'bare' }, { type: 'set_model', provider: 'p', modelId: 'plain' }, { type: 'set_thinking_level', level: state.thinkingLevel }]);
});

for (const [choice, change] of [
  ['agent', draft => draft.command({ type: 'select_agent', agent: 'general' })],
  ['model', draft => draft.command({ type: 'set_model', provider: 'p', modelId: 'plain' })],
  ['fast mode', draft => draft.setFastMode(false)],
]) {
  test(`a draft keeps the user's ${choice} choice when the host default changes`, async t => {
    const { draft, shown, changeDefault } = hostDraft(t);
    await draft.applyDefaults('medium', false);
    await change(draft);
    await changeDefault();
    assert.equal(shown(), 'general');
    assert.equal(draft.changes.get('select_agent')?.agent, 'general');
    assert.equal(draft.fastMode, false);
  });
}

