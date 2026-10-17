import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { SettingsView } from '../../clients/ui/components/SettingsView.tsx';
import { mockIPC } from '../mock-ipc.mjs';
import { defaultKeybindings } from '../../clients/ui/lib/keybindings.ts';

describe('settings editor', () => {
  let dom, view, props, saves, dirty, supportedModels;
  beforeEach(() => {
    dom = installDom(); saves = []; dirty = []; supportedModels = ['model'];
    mockIPC((command, args) => {
      if (command === 'provider_auth' && args.request.action === 'fast_models') return { ready: true, providers: { p: { supportedModelIds: supportedModels } } };
      throw new Error('Unexpected command: ' + command);
    }, { shouldMockEvents: true });
    props = { providerHostId: 'local', settings: { defaultAgent: 'general', hiddenModels: [], defaultThinking: 'off', defaultFastMode: false, contextWindowCap: 100_000, modelContextWindowCaps: {}, contextWindowCapEnabled: true, autoCompaction: true, autoRetry: true, debugMode: false, keybindings: { ...defaultKeybindings }, tools: [], skills: [], hosts: [] }, onSave: async (...args) => saves.push(args), onDirtyChange: value => dirty.push(value) };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });

  async function render(extra = {}) { props = { ...props, ...extra };

  if (view) await view.rerender(props); else view = await renderComponent(SettingsView, props); }

  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const click = async element => act(async () => element.click());
  const save = () => document.querySelector('.settings-save > button');
  const section = async name => click([...document.querySelectorAll('nav button')].find(item => item.textContent === name));
  const select = async (label, value) => act(async () => { control(label).value = value; control(label).dispatchEvent(new Event('change', { bubbles: true })); });
  const selectAgent = async name => click([...document.querySelectorAll('.agent-list button')].find(item => item.textContent === name));
  const profile = (name, extra = {}) => ({ name, model: '', effort: '', path_systemprompt: 'system.md', path_agent_prompt: '', tools: [], skills: [], mcpServers: {}, ...extra });

  test('model aliases save with stable model IDs and appear in agent choices', async () => {
    await render({ models: [{ provider: 'p', id: 'model', name: 'Original' }], agentConfig: { agents: [profile('general', { model: 'p/model' })] } });
    await section('Inference');
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

  test('MCP JSON validation rejects bad URLs, headers, arguments and timeouts before saving', async () => {
    await render({ agentConfig: { agents: [profile('general')] } }); await section('Agents');
    const editor = () => control('MCP server configuration');

    for (const text of ['{bad', '[]', '{"search":{"url":"file:///tmp/x"}}', '{"search":{"url":"https://example.com/mcp","headers":{"a":3}}}', '{"search":{"command":"server","args":"one two"}}', '{"search":{"command":"server","timeout":0}}']) {
      await enterText(editor(), text);
      assert.ok(document.querySelector('.mcp-error'));
      assert.equal(save().disabled, true);
      assert.equal(saves.length, 0);
    }

    const servers = { search: { url: 'https://example.com/mcp', headers: { Authorization: 'test' }, timeout: 20000 } };
    await enterText(editor(), JSON.stringify(servers)); assert.equal(document.querySelector('.mcp-error'), null);
    await click(save()); assert.deepEqual(saves[0][1].agents[0].mcpServers, servers);
    await enterText(editor(), '{"search":{"command":""}}'); assert.match(document.querySelector('.mcp-error').textContent, /requires a command/);
    await enterText(editor(), '{}'); await click(save()); assert.deepEqual(saves[1][1].agents[0].mcpServers, {});
  });

  test('MCP edits and deletion stay within the selected agent even when server ids match', async () => {
    const generalServer = { command: 'general-server', args: [], enabled: true };
    const reviewServer = { command: 'review-server', args: [], enabled: true };
    const config = { agents: [profile('general', { mcpServers: { shared: generalServer } }), profile('review', { mcpServers: { shared: reviewServer } })] };
    await render({ agentConfig: config }); await section('Agents'); await selectAgent('review');
    assert.deepEqual(JSON.parse(control('MCP server configuration').value), { shared: reviewServer });
    const edited = { ...reviewServer, command: 'changed-review-server', enabled: false };
    await enterText(control('MCP server configuration'), JSON.stringify({ shared: edited }));
    await click(document.querySelector('.agent-list button'));
    assert.deepEqual(JSON.parse(control('MCP server configuration').value), { shared: generalServer });
    await click(save());
    assert.equal('mcpServers' in saves[0][0], false);
    assert.deepEqual(saves[0][1].agents[0].mcpServers, { shared: generalServer });
    assert.deepEqual(saves[0][1].agents[1].mcpServers, { shared: edited });
    await enterText(control('MCP server configuration'), '{}'); await click(save());
    assert.deepEqual(saves[1][1].agents[0].mcpServers, {});
    assert.deepEqual(saves[1][1].agents[1].mcpServers, { shared: edited });
    assert.deepEqual(config.agents[1].mcpServers, { shared: reviewServer });
  });

  test('machine removal requires confirmation when sessions use it', async () => {
    props.settings.hosts = [{ id: 'remote', name: 'Remote', target: 'user@host', piPath: 'pi' }];
    await render({ sessions: [{ hostId: 'remote' }, { hostId: 'remote' }] }); await section('Machines');
    await click(control('Remove Remote')); assert.match(document.querySelector('dialog').textContent, /files and conversations will remain on the remote machine/);
    await click(button('Cancel')); assert.ok(control('Remove Remote'));
    await click(control('Remove Remote')); await click(button('Remove machine')); assert.equal(control('Remove Remote'), null);
    await click(save()); assert.deepEqual(saves[0][0].hosts, []);
  });

  test('agent edits save defaults, prompts and resource permissions without changing the built-in identity', async () => {
    props.settings.tools = [{ name: 'read', enabled: true }]; props.settings.skills = [{ name: 'Research', path: '/research', enabled: true }];
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

  test('renaming and deleting the default agent maintain a valid default', async () => {
    props.settings.defaultAgent = 'review';
    await render({ agentConfig: { agents: [profile('general'), profile('review')] } }); await section('Agents'); await selectAgent('review');
    await enterText(control('Agent name'), 'renamed'); await click(save()); assert.equal(saves[0][0].defaultAgent, 'renamed');
    await click(control('Remove renamed')); await click(save()); assert.equal(saves[1][0].defaultAgent, 'general'); assert.deepEqual(saves[1][1].agents.map(agent => agent.name), ['general']);
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
    assert.match(control('MCP server configuration').value, /existing/);
    await enterText(control('MCP server configuration'), '{}');
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

  test('new machines reject reserved names and save valid connection details', async () => {
    await render(); await section('Machines');
    await click(button('Add machine'));
    await enterText(control('Machine name'), 'Local');
    assert.match(document.querySelector('[role=alert]').textContent, /reserved/);
    assert.equal(save().disabled, true);
    await enterText(control('Machine name'), 'Build');
    await enterText(control('Build SSH target'), 'builder@host');
    await enterText(control('Build Piop daemon executable'), '/opt/pi');
    await click(save());
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].hosts.length, 1);
    assert.equal(saves[0][0].hosts[0].name, 'Build');
    assert.equal(saves[0][0].hosts[0].target, 'builder@host');
    assert.equal(saves[0][0].hosts[0].piPath, '/opt/pi');
  });

  test('new agents inherit only enabled resources', async () => {
    props.settings.tools = [{ name: 'read', enabled: true }, { name: 'write', enabled: false }];
    await render({ agentConfig: { agents: [profile('general')] } }); await section('Agents');
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

  test('new machines receive distinct nonempty IDs when saved', async () => {
    await render(); await section('Machines');
    for (const [name, target] of [['Build one', 'builder@one'], ['Build two', 'builder@two']]) {
      await click(button('Add machine'));
      const input = [...document.querySelectorAll('[aria-label="Machine name"]')].find(element => element.value === 'New machine');
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
