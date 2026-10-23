import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act, untilDom } from '../dom.mjs';
import { SettingsView } from '../../clients/ui/components/SettingsView.tsx';
import { mockIPC } from '../mock-ipc.mjs';
import { refreshPlugins } from '../../clients/ui/plugins/index.ts';
import { defaultKeybindings } from '../../clients/ui/lib/keybindings.ts';

describe('settings editor', () => {
  let dom, view, props, saves, dirty, supportedModels;
  beforeEach(() => {
    dom = installDom(); saves = []; dirty = []; supportedModels = ['model'];
    mockIPC((command, args) => {
      if (command === 'plugin_status') return { enabled: ['cost', 'review'], configured: ['cost', 'review'], revision: 'settings-1', error: null };
      if (command === 'provider_auth' && args.request.action === 'fast_models') return { ready: true, providers: { p: { supportedModelIds: supportedModels } } };
      throw new Error('Unexpected command: ' + command);
    }, { shouldMockEvents: true });
    props = { providerHostId: 'local', settings: { hiddenModels: [], defaultThinking: 'off', defaultFastMode: false, contextWindowCap: 100_000, modelContextWindowCaps: {}, contextWindowCapEnabled: true, autoCompaction: true, autoRetry: true, debugMode: false, keybindings: { ...defaultKeybindings }, tools: [], skills: [], hosts: [] }, onSave: async (...args) => saves.push(args), onDirtyChange: value => dirty.push(value) };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });

  async function render(extra = {}) { props = { ...props, ...extra };

  if (view) await view.rerender(props); else view = await renderComponent(SettingsView, props); }

  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const click = async element => act(async () => element.click());
  const mcpJson = async () => { if (!control('MCP server configuration')) await click(control('Edit MCP servers as JSON')); return control('MCP server configuration'); };
  const save = () => document.querySelector('.settings-save > .primary-button');
  const section = async name => click([...document.querySelectorAll('nav button')].find(item => item.textContent === name));
  const select = async (label, value) => act(async () => { control(label).value = value; control(label).dispatchEvent(new Event('change', { bubbles: true })); });
  const selectAgent = async name => click([...document.querySelectorAll('.agent-list button')].find(item => item.textContent === name));
  const profile = (name, extra = {}) => ({ name, ...(name === 'general' ? { isDefault: true } : {}), model: '', effort: '', path_systemprompt: 'system.md', path_agent_prompt: '', tools: [], skills: [], mcpServers: {}, allowed_subagents: 'all', allowed_peers: 'all', ...extra });

  test('model aliases save with stable model IDs and appear in agent choices', async () => {
    await render({ models: [{ provider: 'p', id: 'model', name: 'Original' }], agentConfig: { agents: [profile('general', { model: 'p/model' })] } });
    await section('Inference');
    await click(control('Edit alias for p/model'));
    const input = control('Alias for p/model');
    await enterText(input, 'My model');
    assert.equal(control('Alias for p/model'), input);
    await click(save());
    assert.deepEqual(saves[0][0].modelAliases, { 'p/model': 'My model' });
    await section('Agents');
    assert.equal(control('Agent default model').value, 'p/model');
    assert.equal(control('Agent default model').selectedOptions[0].textContent, 'My model');
  });

  test('save tracks dirty state, deduplicates requests and preserves edits made while saving', async () => {
    const pending = Promise.withResolvers();
    await render({ onSave: (...args) => { saves.push(args);

    return pending.promise; } }); assert.equal(save().disabled, true); assert.equal(dirty.at(-1), false);
    await click(control('Automatic retry')); assert.equal(dirty.at(-1), true);
    await act(async () => { save().click(); save().click(); }); assert.equal(saves.length, 1); assert.equal(saves[0][0].autoRetry, false); assert.equal(save().textContent, 'Saving…');
    await enterText(control('Context window cap'), '200000');
    await act(async () => pending.resolve()); assert.equal(save().disabled, false); assert.equal(dirty.at(-1), true);
    await render({ onSave: async (...args) => saves.push(args) }); await click(save());
    assert.equal(saves[1][0].contextWindowCap, 200000); assert.equal(save().textContent, 'Saved'); assert.equal(dirty.at(-1), false);
  });

  test('save failures keep edits available for correction', async () => {
    await render({ onSave: async () => { throw new Error('disk full'); } });
    await enterText(control('Context window cap'), '200000'); await click(save()); assert.equal(document.querySelector('[role=alert]').textContent, 'disk full'); assert.equal(save().disabled, false);
    await click(control('Automatic retry')); assert.equal(document.querySelector('[role=alert]'), null);
  });

  test('model visibility retains hidden unavailable models when a listed model is hidden then shown', async () => {
    props.settings.hiddenModels = ['old/missing'];
    await render({ models: [{ provider: 'p', id: 'model', name: 'Current' }] });
    await section('Inference');
    assert.equal(control('Show old/missing'), null); assert.equal(control('Show p/model').getAttribute('aria-checked'), 'true');
    await click(control('Show p/model')); await click(save()); assert.deepEqual(saves[0][0].hiddenModels, ['old/missing', 'p/model']);
    await click(control('Show p/model'));
    await click(save()); assert.deepEqual(saves[1][0].hiddenModels, ['old/missing']);
  });

  test('hiding a model keeps model visibility changes that arrive from another window', async () => {
    props.settings.hiddenModels = ['p/b'];
    await render({ models: ['a', 'b', 'c'].map(id => ({ provider: 'p', id, name: id })) });
    await section('Inference');
    await click(control('Show p/a'));
    await render({ settings: { ...props.settings, hiddenModels: ['p/c'] } });
    assert.equal(control('Show p/b').getAttribute('aria-checked'), 'true');
    await click(save());
    assert.deepEqual(saves[0][0].hiddenModels.toSorted(), ['p/a', 'p/c']);
  });

  test('remote-only hidden models stay hidden when all listed models are disabled and enabled again', async () => {
    props.settings.hiddenModels = ['remote/model'];
    props.settings.knownModels = ['remote/model'];
    await render({ models: [{ provider: 'p', id: 'model', name: 'Local' }] });
    await section('Inference');
    assert.equal(control('Show remote/model'), null);
    assert.equal(button('Enable all models').disabled, true);
    await click(button('Disable all models')); assert.equal(control('Show p/model').getAttribute('aria-checked'), 'false');
    await click(save()); assert.deepEqual(saves[0][0].hiddenModels, ['remote/model', 'p/model']);
    await click(button('Enable all models')); assert.equal(control('Show p/model').getAttribute('aria-checked'), 'true');
    await click(save()); assert.deepEqual(saves[1][0].hiddenModels, ['remote/model']); assert.deepEqual(saves[1][0].knownModels, ['remote/model']);
  });

  test('the Review sub-tab of Agents sets the review agent and marks one that no longer exists', async () => {
    await render({ settings: { ...props.settings, reviewAgent: 'gone' }, agentConfig: { agents: [profile('general'), profile('reviewer')] } });
    await section('Review');
    const agent = control('Review agent');
    assert.equal(agent.value, 'gone');
    assert.equal(agent.selectedOptions[0].textContent, 'Unavailable: gone');
    await act(async () => { agent.value = 'reviewer'; agent.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(save());
    assert.equal(saves[0][0].reviewAgent, 'reviewer');
  });

  test('the review agent choice follows the selected host plugin state without clearing saved choices', async () => {
    let enabled = ['cost', 'review'];
    mockIPC(command => {
      if (command === 'plugin_status') return { enabled, configured: enabled, revision: enabled.join(','), error: null };
      throw new Error('Unexpected command: ' + command);
    }, { shouldMockEvents: true });
    await render({ scope: 'daemon', settings: { ...props.settings, reviewAgent: 'general' }, agentConfig: { agents: [profile('general')] } });
    await section('Review');
    await untilDom(() => control('Review agent'));
    enabled = ['cost'];
    await act(() => refreshPlugins('local'));
    await untilDom(() => !control('Review agent'));
    enabled = ['cost', 'review'];
    await act(() => refreshPlugins('local'));
    await untilDom(() => control('Review agent'));
    assert.equal(control('Review agent').value, 'general');
    assert.equal(saves.length, 0);
  });

  test('subagent limits are saved as whole numbers, and a cleared or invalid limit cannot be saved', async () => {
    await render({ settings: { ...props.settings, tools: [{ name: 'spawn_subagents', description: '', source: '/x/session-broker.ts' }] }, agentConfig: { agents: [profile('general', { tools: ['spawn_subagents'] })] } });
    await section('Agents');
    const limit = control('Max subagents');
    assert.equal(limit.value, '8');
    await enterText(limit, '3');
    await click(save());
    assert.equal(saves[0][1].agents[0].max_subagents, 3);
    for (const text of ['', '2.5', '-1']) {
      await enterText(control('Max subagents'), text);
      assert.equal(save().disabled, true, JSON.stringify(text) + ' cannot be saved');
      assert.match(document.querySelector('[role=alert]')?.textContent ?? '', /Every agent needs a unique name and valid resources/);
    }
    assert.equal(saves.length, 1);
  });

  test('MCP JSON validation rejects bad URLs, headers, arguments and timeouts before saving', async () => {
    await render({ agentConfig: { agents: [profile('general')] } }); await section('Agents');
    const editor = mcpJson;

    for (const text of ['{bad', '[]', '{"search":{"url":"file:///tmp/x"}}', '{"search":{"url":"https://example.com/mcp","headers":{"a":3}}}', '{"search":{"command":"server","args":"one two"}}', '{"search":{"command":"server","timeout":0}}']) {
      await enterText(await editor(), text);
      assert.ok(document.querySelector('.mcp-error'));
      assert.equal(save().disabled, true);
      assert.equal(saves.length, 0);
    }

    const servers = { search: { url: 'https://example.com/mcp', headers: { Authorization: 'test' }, timeout: 20000 } };
    await enterText(await editor(), JSON.stringify(servers)); assert.equal(document.querySelector('.mcp-error'), null);
    await click(save()); assert.deepEqual(saves[0][1].agents[0].mcpServers, servers);
    await enterText(await editor(), '{"search":{"command":""}}'); assert.match(document.querySelector('.mcp-error').textContent, /requires a command/);
    await enterText(await editor(), '{}'); await click(save()); assert.deepEqual(saves[1][1].agents[0].mcpServers, {});
  });

  test('MCP server form adds, renames and switches a server to a URL', async () => {
    await render({ agentConfig: { agents: [profile('general')] } }); await section('Agents');
    const change = async (label, value) => act(async () => { control(label).value = value; control(label).dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button('Add server'));
    assert.ok(document.querySelector('.mcp-error')); assert.equal(save().disabled, true);
    await enterText(control('server command'), 'npx');
    await change('server arguments', '-y\n  tool@1  \n\n');
    await change('MCP server name', 'tool');
    assert.equal(document.querySelector('.mcp-error'), null);
    await click(save());
    assert.deepEqual(saves[0][1].agents[0].mcpServers, { tool: { command: 'npx', args: ['-y', 'tool@1'] } });
    await click(control('Enable tool'));
    await click(button('URL'));
    await enterText(control('tool URL'), 'https://example.com/mcp');
    await click(save());
    assert.deepEqual(saves[1][1].agents[0].mcpServers, { tool: { enabled: false, url: 'https://example.com/mcp' } });
    await click(control('Remove tool'));
    assert.ok(button('Add server')); await click(save());
    assert.deepEqual(saves[2][1].agents[0].mcpServers, {});
  });

  test('MCP edits and deletion stay within the selected agent even when server ids match', async () => {
    const generalServer = { command: 'general-server', args: [], enabled: true };
    const reviewServer = { command: 'review-server', args: [], enabled: true };
    const config = { agents: [profile('general', { mcpServers: { shared: generalServer } }), profile('review', { mcpServers: { shared: reviewServer } })] };
    await render({ agentConfig: config }); await section('Agents'); await selectAgent('review');
    assert.deepEqual(JSON.parse((await mcpJson()).value), { shared: reviewServer });
    const edited = { ...reviewServer, command: 'changed-review-server', enabled: false };
    await enterText((await mcpJson()), JSON.stringify({ shared: edited }));
    await click(document.querySelector('.agent-list button'));
    assert.deepEqual(JSON.parse((await mcpJson()).value), { shared: generalServer });
    await click(save());
    assert.equal('mcpServers' in saves[0][0], false);
    assert.deepEqual(saves[0][1].agents[0].mcpServers, { shared: generalServer });
    assert.deepEqual(saves[0][1].agents[1].mcpServers, { shared: edited });
    await enterText((await mcpJson()), '{}'); await click(save());
    assert.deepEqual(saves[1][1].agents[0].mcpServers, {});
    assert.deepEqual(saves[1][1].agents[1].mcpServers, { shared: edited });
    assert.deepEqual(config.agents[1].mcpServers, { shared: reviewServer });
  });

  test('host removal requires confirmation when sessions use it', async () => {
    props.settings.hosts = [{ id: 'remote', name: 'Remote', target: 'user@host', piPath: 'pi' }];
    await render({ sessions: [{ hostId: 'remote' }, { hostId: 'remote' }] }); await section('Hosts');
    await click(control('Remove Remote')); assert.match(document.querySelector('dialog').textContent, /files and conversations will remain on the remote host/);
    await click(button('Cancel')); assert.ok(control('Remove Remote'));
    await click(control('Remove Remote')); await click(button('Remove host')); assert.equal(control('Remove Remote'), null);
    await click(save()); assert.deepEqual(saves[0][0].hosts, []);
  });

  test('agent edits save defaults, prompts and resource permissions without changing the built-in identity', async () => {
    props.settings.tools = [{ name: 'read', description: '', source: 'builtin:read' }]; props.settings.skills = [{ name: 'Research', path: '/research', enabled: true }];
    await render({ agentConfig: { agents: [profile('general'), profile('review')] }, models: [{ provider: 'p', id: 'model', reasoning: true }] });
    await section('Agents'); await selectAgent('review'); assert.equal(control('Agent name').value, 'review');
    await enterText(control('Agent name'), 'code review!'); assert.equal(control('Agent name').value, 'codereview');
    await enterText(control('Agent name'), 'general'); assert.equal(control('Agent name').value, 'codereview');
    await select('Agent default model', 'p/model'); await select('Agent default effort', 'high'); await click(control('Agent fast mode'));
    await enterText(control('System prompt file'), 'review.md'); await enterText(control('Agent prompt file'), 'extra.md');

    for (const label of ['Allow read', 'Allow Research']) await click(control(label));
    await click(control('Allow read')); await click(control('Allow read')); await click(save());
    assert.deepEqual(saves[0][1].agents[1], profile('codereview', { model: 'p/model', effort: 'high', fastMode: true, path_systemprompt: 'review.md', path_agent_prompt: 'extra.md', tools: ['read'], skills: ['/research'], mcpServers: {} }));
    await click(document.querySelector('.agent-list button')); assert.equal(control('Agent name').disabled, true); assert.equal(control('Remove general').disabled, true);
  });

  test('tool and skill searches filter by name and by group name', async () => {
    props.settings.tools = [{ name: 'read', description: '', source: 'builtin:read' }, { name: 'bash', description: '', source: 'builtin:bash' }, { name: 'update_goal_status', description: '', source: '/x/piop-goals/index.ts' }];
    props.settings.skills = [{ name: 'tdd', path: '/h/.agents/skills/using/tdd', enabled: true }, { name: 'retro', path: '/h/.agents/skills/mine/retro', enabled: true }];
    await render({ agentConfig: { agents: [profile('general'), profile('review')] } });
    await section('Agents'); await selectAgent('review');
    await enterText(control('Search tools'), 'EAD');
    assert.ok(control('Allow read')); assert.equal(control('Allow bash'), null); assert.equal(control('Allow all Goal tools'), null);
    await enterText(control('Search tools'), 'update');
    assert.equal(control('Allow read'), null); assert.ok(control('Allow update_goal_status')); assert.equal(control('Allow bash'), null);
    await click(control('Allow all Goal tools'));
    await enterText(control('Search tools'), 'goal');
    assert.equal(control('Allow update_goal_status').checked, true);
    await enterText(control('Search skills'), 'mine');
    assert.ok(control('Allow retro')); assert.equal(control('Allow tdd'), null);
    await enterText(control('Search skills'), '');
    assert.ok(control('Allow retro')); assert.ok(control('Allow tdd'));
  });

  test('agent extensions are added, edited and removed one path at a time', async () => {
    await render({ agentConfig: { agents: [profile('general'), profile('review', { extensions: ['/ext/first.ts'] })] } });
    await section('Agents'); await selectAgent('review');
    const change = async (label, value) => act(async () => { control(label).value = value; control(label).dispatchEvent(new Event('change', { bubbles: true })); });
    await enterText(control('New extension path'), ' /ext/one.ts ');
    await act(async () => control('New extension path').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.equal(control('New extension path').value, '');
    await enterText(control('New extension path'), '/ext/one.ts'); await click(button('Add'));
    assert.match(document.querySelector('.agent-extensions [role=alert]').textContent, /already added/);
    await change('Extension 1', '/ext/rtk.ts');
    await click(control('Remove /ext/one.ts'));
    await click(save());
    assert.deepEqual(saves[0][1].agents[1].extensions, ['/ext/rtk.ts']);
  });

  test('agent skills are grouped by their folder in ~/.agents/skills', async () => {
    props.settings.skills = [
      { name: 'top', path: '/home/u/.agents/skills/top', enabled: true },
      { name: 'tdd', path: '/home/u/.agents/skills/using/tdd', enabled: true },
      { name: 'bugfix', path: '/home/u/.agents/skills/using/bugfix', enabled: true },
      { name: 'retro', path: '/home/u/.agents/skills/mine/retro', enabled: true },
    ];
    await render({ agentConfig: { agents: [profile('general'), profile('review')] } });
    await section('Agents'); await selectAgent('review');
    const group = name => document.querySelector(`section[aria-label="${name} skills"]`);
    assert.deepEqual([...group('using').querySelectorAll('.agent-tool-group-members label')].map(label => label.textContent), ['tdd', 'bugfix']);
    assert.deepEqual([...group('mine').querySelectorAll('.agent-tool-group-members label')].map(label => label.textContent), ['retro']);
    assert.equal(control('Allow top').closest('.agent-tool-group'), null);
    await click(control('Allow all using skills'));
    assert.equal(control('Allow tdd').checked, true); assert.equal(control('Allow bugfix').checked, true); assert.equal(control('Allow retro').checked, false);
    await click(save());
    assert.deepEqual(saves[0][1].agents[1].skills, ['/home/u/.agents/skills/using/tdd', '/home/u/.agents/skills/using/bugfix']);
  });

  test('the default agent flag follows a rename and returns to general when its agent is removed', async () => {
    await render({ agentConfig: { agents: [profile('general'), profile('review')] } }); await section('General');
    await select('Default agent', 'review'); await section('Agents'); await selectAgent('review');
    await enterText(control('Agent name'), 'renamed'); await click(save());
    assert.deepEqual(saves[0][1].agents.map(agent => [agent.name, agent.isDefault]), [['general', undefined], ['renamed', true]]);
    await click(control('Remove renamed')); await click(save());
    assert.deepEqual(saves[1][1].agents.map(agent => [agent.name, agent.isDefault]), [['general', true]]);
  });

  test('unavailable agent settings prevent saving until all errors are corrected', async () => {
    supportedModels = [];
    props.providerHostId = 'unsupported-models';
    await render({ agentConfig: { agents: [profile('general'), profile('review', { model: 'p/missing', effort: 'extreme', mcpServers: { existing: { command: 'cmd', args: [], enabled: true } } })] }, models: [{ provider: 'p', id: 'model', reasoning: true }], thinkingLevels: ['off', 'high'] });
    await click(control('Automatic retry'));
    await section('Agents'); await selectAgent('review'); assert.match(document.querySelector('[role=alert]').textContent, /model is unavailable/); assert.equal(save().disabled, true);
    await select('Agent default model', 'p/model'); assert.match(document.querySelector('[role=alert]').textContent, /effort is unavailable/); assert.equal(save().disabled, true);
    await select('Agent default effort', 'high');
    await enterText(control('System prompt file'), ''); assert.match(document.querySelector('[role=alert]').textContent, /system prompt file is required/); assert.equal(save().disabled, true);
    await enterText(control('System prompt file'), 'system.md'); await click(control('Agent fast mode')); assert.match(document.querySelector('[role=alert]').textContent, /does not support fast mode/); assert.equal(save().disabled, true);
    await click(control('Agent fast mode')); assert.equal(save().disabled, false);
    await click(save()); assert.equal(saves.length, 1);
    assert.equal(saves[0][1].agents[1].model, 'p/model');
    assert.equal(saves[0][1].agents[1].effort, 'high');
    assert.equal(saves[0][1].agents[1].path_systemprompt, 'system.md');
    assert.equal(saves[0][1].agents[1].fastMode, false);
  });

  test('removing embedded servers saves an empty server configuration', async () => {
    await render({ agentConfig: { agents: [profile('general'), profile('review', { mcpServers: { existing: { command: 'cmd', args: [], enabled: true } } })] } });
    await section('Agents'); await selectAgent('review');
    assert.match((await mcpJson()).value, /existing/);
    await enterText((await mcpJson()), '{}');
    await click(save());
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0][1].agents[1].mcpServers, {});
  });

  test('late configuration discovery preserves general edits and leaves existing agent edits intact', async () => {
    await render(); await click(control('Automatic retry'));
    await render({ agentConfig: { agents: [profile('general'), profile('discovered')] } }); await section('Agents'); await selectAgent('discovered'); assert.equal(control('Agent name').value, 'discovered');
    await click(save()); assert.equal(saves[0][0].autoRetry, false); assert.equal(saves[0][1], undefined);
    await enterText(control('Agent name'), 'edited');
    await render({ agentConfig: { agents: [profile('general'), profile('external')] } }); assert.equal(control('Agent name').value, 'edited');
    assert.equal(save().disabled, true); assert.equal(saves.length, 1);
    assert.match(document.querySelector('[role=alert]').textContent, /changed/i);
  });

  test('configuration refresh during save keeps agent capabilities until completion', async () => {
    const pending = Promise.withResolvers();
    await render({ agentConfig: { agents: [profile('general'), profile('review')] }, onSave: () => pending.promise }); await section('Agents'); await enterText(control('Agent prompt file'), 'new.md'); await click(save());
    await render({ agentConfig: undefined }); assert.ok(control('Agent name')); assert.equal(control('Agent prompt file').value, 'new.md');
    await act(async () => pending.resolve()); assert.equal(control('Agent name'), null); assert.match(document.body.textContent, /Loading/);
  });
  test('saved settings show how many sessions still need to apply changes', async () => {
    await render({ pendingSettingsCount: 2 });
    assert.equal(document.querySelector('[role=status]').textContent, 'Saved · waiting for 2 sessions to apply changes');
  });

  test('a colliding change from another window blocks saving until the latest settings are reloaded', async () => {
    await render();
    await enterText(control('Context window cap'), '200000');
    await render({ settings: { ...props.settings, contextWindowCap: 300_000, settingsRevision: 2 } });
    assert.match(document.querySelector('[role=alert]').textContent, /changed in another window/);
    assert.equal(save().disabled, true);
    await click(button('Reload latest settings and discard local edits'));
    assert.equal(control('Context window cap').value, '300000');
    assert.equal(document.querySelector('[role=alert]'), null);
    await click(control('Automatic retry'));
    await click(save());
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].contextWindowCap, 300_000);
    assert.equal(saves[0][0].autoRetry, false);
  });

  test('an agent change from another window blocks saving agent edits until the latest agents are reloaded', async () => {
    await render({ agentConfig: { revision: 'original-agent-revision', agents: [profile('general'), profile('review', { path_agent_prompt: 'old.md' })] } });
    await section('Agents'); await selectAgent('review');
    await enterText(control('Agent prompt file'), 'mine.md');
    await render({ agentConfig: { revision: 'latest-agent-revision', agents: [profile('general'), profile('review', { path_agent_prompt: 'theirs.md' })] } });
    assert.match(document.querySelector('[role=alert]').textContent, /changed in another window/);
    assert.equal(save().disabled, true);
    await click(save());
    assert.equal(saves.length, 0);
    await click(button('Reload latest settings and discard local edits'));
    assert.equal(document.querySelector('[role=alert]'), null);
    assert.equal(control('Agent name').value, 'review');
    assert.equal(control('Agent prompt file').value, 'theirs.md');
    await enterText(control('System prompt file'), 'review.md');
    await click(save());
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0][1], { revision: 'latest-agent-revision', agents: [profile('general'), profile('review', { path_systemprompt: 'review.md', path_agent_prompt: 'theirs.md' })] });
  });

  test('an agent revision change without content changes keeps agent edits and saves them with the new revision', async () => {
    await render({ agentConfig: { revision: 'original-agent-revision', agents: [profile('general'), profile('review', { path_agent_prompt: 'old.md' })] } });
    await section('Agents'); await selectAgent('review');
    await enterText(control('Agent prompt file'), 'mine.md');
    await render({ agentConfig: { revision: 'fresh-agent-revision', agents: [profile('general'), profile('review', { path_agent_prompt: 'old.md' })] } });
    assert.equal(document.querySelector('[role=alert]'), null);
    assert.equal(control('Agent prompt file').value, 'mine.md');
    await click(save());
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0][1], { revision: 'fresh-agent-revision', agents: [profile('general'), profile('review', { path_agent_prompt: 'mine.md' })] });
  });

  test('unconfirmed disk durability offers a retry without edits and clears once confirmed', async () => {
    await render({ settings: { ...props.settings, settingsDurabilityError: 'fsync failed' } });
    assert.match(document.querySelector('[role=alert]').textContent, /durability is unconfirmed: fsync failed/);
    assert.equal(save().textContent, 'Retry save');
    assert.equal(dirty.at(-1), true);
    await click(save());
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].contextWindowCap, 100_000);
    const { settingsDurabilityError: _error, ...confirmed } = saves[0][0];
    await render({ settings: { ...confirmed, settingsRevision: 2 } });
    assert.equal(document.querySelector('[role=alert]'), null);
    assert.equal(save().disabled, true);
    assert.equal(dirty.at(-1), false);
  });

  test('turning off the context cap disables its value input', async () => {
    await render();
    assert.equal(control('Context window cap').disabled, false);
    await click(control('Enable context window cap'));
    assert.equal(control('Context window cap').disabled, true);
  });

  test('a context cap below the minimum cannot be saved', async () => {
    await render();
    await enterText(control('Context window cap'), '999');
    assert.match(document.querySelector('[role=alert]').textContent, /from 100,000 to 50,000,000/);
    assert.equal(save().disabled, true);
    await click(save());
    assert.deepEqual(saves, []);
  });

  test('an unmatched model filter shows an empty result that can be cleared', async () => {
    await render({ models: [{ provider: 'p', id: 'model', name: 'Current' }] });
    await section('Inference');
    await enterText(control('Filter models'), 'absent');
    assert.match(document.body.textContent, /No models match/);
    assert.equal(control('Show p/model'), null);
    await enterText(control('Filter models'), '');
    assert.ok(control('Show p/model'));
    assert.doesNotMatch(document.body.textContent, /No models match/);
  });

  test('new hosts reject reserved names and save valid connection details', async () => {
    await render(); await section('Hosts');
    await click(button('Add host'));
    await enterText(control('Host name'), 'Local');
    assert.match(document.querySelector('[role=alert]').textContent, /reserved/);
    assert.equal(save().disabled, true);
    await enterText(control('Host name'), 'Build');
    await enterText(control('Build SSH target'), 'builder@host');
    await enterText(control('Build Piop daemon executable'), '/opt/pi');
    await click(save());
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].hosts.length, 1);
    assert.equal(saves[0][0].hosts[0].name, 'Build');
    assert.equal(saves[0][0].hosts[0].target, 'builder@host');
    assert.equal(saves[0][0].hosts[0].piPath, '/opt/pi');
  });

  test('new agents start with the tools of the general agent and only enabled skills', async () => {
    props.settings.tools = [{ name: 'read', description: '', source: 'builtin:read' }, { name: 'write', description: '', source: 'builtin:write' }];
    await render({ agentConfig: { agents: [profile('general', { tools: ['read'] })] } }); await section('Agents');
    await click(button('Add agent'));
    assert.equal(control('Allow read').checked, true);
    assert.equal(control('Allow write').checked, false);
    await click(save());
    assert.deepEqual(saves[0][1].agents[1].tools, ['read']);
  });

  test('new agents receive distinct names', async () => {
    await render({ agentConfig: { agents: [profile('general')] } }); await section('Agents');
    await click(button('Add agent')); const firstName = control('Agent name').value;
    await click(button('Add agent')); const secondName = control('Agent name').value;
    assert.notEqual(secondName, firstName);
    await click(save());
    assert.deepEqual(saves[0][1].agents.map(agent => agent.name), ['general', firstName, secondName]);
  });

  test('new hosts receive distinct nonempty IDs when saved', async () => {
    await render(); await section('Hosts');
    for (const [name, target] of [['Build one', 'builder@one'], ['Build two', 'builder@two']]) {
      await click(button('Add host'));
      const input = [...document.querySelectorAll('[aria-label="Host name"]')].find(element => element.value === 'New host');
      await enterText(input, name);
      await enterText(control(`${name} SSH target`), target);
    }
    await click(button('Save changes'));
    const hosts = saves[0][0].hosts;
    assert.deepEqual(hosts.map(({ name, target }) => ({ name, target })), [{ name: 'Build one', target: 'builder@one' }, { name: 'Build two', target: 'builder@two' }]);
    assert.ok(hosts.every(host => typeof host.id === 'string' && host.id.length > 0));
    assert.equal(new Set(hosts.map(host => host.id)).size, 2);
  });

});
