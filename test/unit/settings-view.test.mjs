import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { SettingsView } from '../../src/components/SettingsView.tsx';
import { defaultKeybindings } from '../../src/lib/keybindings.ts';

describe('settings editor', () => {
  let dom, view, props, saves, dirty;
  beforeEach(() => {
    dom = installDom(); saves = []; dirty = [];
    props = { settings: { worktreeSetupScripts: [], defaultAgent: 'general', defaultModel: 'p/model', hiddenModels: [], defaultThinking: 'off', defaultFastMode: false, contextWindowCap: 10000, contextWindowCapEnabled: true, autoCompaction: true, autoRetry: true, debugMode: false, keybindings: { ...defaultKeybindings }, tools: [], skills: [], hosts: [] }, onSave: async (...args) => saves.push(args), onDirtyChange: value => dirty.push(value) };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });
  async function render(extra = {}) { props = { ...props, ...extra }; if (view) await view.rerender(props); else view = await renderComponent(SettingsView, props); }
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const click = async element => act(async () => element.click());
  const save = () => document.querySelector('.settings-save > button');
  const section = async name => click([...document.querySelectorAll('nav button')].find(item => item.textContent === name));
  const select = async (label, value) => act(async () => { control(label).value = value; control(label).dispatchEvent(new Event('change', { bubbles: true })); });
  const selectAgent = async name => click([...document.querySelectorAll('.agent-list button')].find(item => item.textContent === name));
  const profile = (name, extra = {}) => ({ name, model: '', effort: '', path_systemprompt: 'system.md', path_agentprompt: '', tools: [], skills: [], mcpServers: [], ...extra });

  test('save tracks dirty state, deduplicates requests and preserves edits made while saving', async () => {
    const pending = Promise.withResolvers();
    await render({ onSave: (...args) => { saves.push(args); return pending.promise; } }); assert.equal(save().disabled, true); assert.equal(dirty.at(-1), false);
    await click(control('Automatic retry')); assert.equal(dirty.at(-1), true);
    await act(async () => { save().click(); save().click(); }); assert.equal(saves.length, 1); assert.equal(saves[0][0].autoRetry, false); assert.equal(save().textContent, 'Saving…');
    await enterText(control('Context window cap'), '20000');
    await act(async () => pending.resolve()); assert.equal(save().disabled, false); assert.equal(dirty.at(-1), true);
    await render({ onSave: async (...args) => saves.push(args), pendingSettingsCount: 2 }); await click(save());
    assert.equal(saves[1][0].contextWindowCap, 20000); assert.equal(save().textContent, 'Saved'); assert.equal(dirty.at(-1), false); assert.match(document.querySelector('.settings-save [role=status]').textContent, /2 sessions/);
  });

  test('save failures keep edits available and validation prevents invalid context caps', async () => {
    await render({ onSave: async () => { throw new Error('disk full'); } });
    await enterText(control('Context window cap'), '999'); assert.equal(save().disabled, true); assert.match(document.querySelector('[role=alert]').textContent, /from 1000 to 10000000/);
    await enterText(control('Context window cap'), '2000'); await click(save()); assert.equal(document.querySelector('[role=alert]').textContent, 'disk full'); assert.equal(save().disabled, false);
    await click(control('Automatic retry')); assert.equal(document.querySelector('[role=alert]'), null);
    await click(control('Enable context window cap')); assert.equal(control('Context window cap').disabled, true);
  });

  test('model visibility retains unavailable models and supports filtering and toggling visibility', async () => {
    props.settings.hiddenModels = ['old/missing'];
    await render({ scope: 'client', models: [{ provider: 'p', id: 'model', name: 'Current' }] });
    await section('Models');
    assert.match(document.body.textContent, /Currently unavailable/); assert.equal(control('Show old/missing').getAttribute('aria-checked'), 'false');
    await click(control('Show p/model')); await click(save()); assert.deepEqual(saves[0][0].hiddenModels, ['old/missing', 'p/model']);
    await enterText(control('Filter models'), 'absent'); assert.match(document.body.textContent, /No models match/);
    await enterText(control('Filter models'), '');
    await click(control('Show old/missing')); await click(control('Show p/model'));
    await click(save()); assert.deepEqual(saves[1][0].hiddenModels, []);
  });


  test('remote-only models remain available to hide again after being enabled', async () => {
    props.settings.hiddenModels = ['remote/model'];
    props.settings.knownModels = ['remote/model'];
    await render({ scope: 'client', models: [{ provider: 'p', id: 'model', name: 'Local' }] });
    await section('Models');
    await click(control('Show remote/model'));
    assert.ok(control('Show remote/model'));
    assert.equal(control('Show remote/model').getAttribute('aria-checked'), 'true');
    await click(control('Show remote/model'));
    await click(save());
    assert.equal(control('Show remote/model').getAttribute('aria-checked'), 'false');
  });

  test('MCP HTTP validation rejects bad URLs, headers and timeouts before saving', async () => {
    await render({ agentConfig: { agents: [profile('general')] } }); await section('Agents'); await click(button('Add MCP server')); await enterText(control('Server name'), 'Search');
    await click(button('HTTP')); const fields = () => document.querySelectorAll('.http-fields input');
    assert.match(document.querySelector('.mcp-error').textContent, /valid HTTP URL/);
    await enterText(fields()[0], 'file:///tmp/x'); assert.match(document.querySelector('.mcp-error').textContent, /HTTP or HTTPS/);
    await enterText(fields()[0], 'https://example.com/mcp');
    for (const [headers, error] of [['{bad', 'valid JSON'], ['[]', 'string values'], ['{"a":3}', 'string values'], ['null', 'string values']]) { await enterText(fields()[1], headers); assert.match(document.querySelector('.mcp-error').textContent, new RegExp(error)); }
    await enterText(fields()[1], '{"Authorization":"test"}'); await enterText(control('Search startup timeout'), '0'); assert.match(document.querySelector('.mcp-error').textContent, /between 1 and 600/);
    await enterText(control('Search startup timeout'), '20'); await click(save()); assert.equal(saves[0][1].agents[0].mcpServers[0].startupTimeoutSec, 20); assert.equal(saves[0][1].agents[0].mcpServers[0].url, 'https://example.com/mcp');
    await click(button('stdio')); await enterText(document.querySelector('.stdio-fields input'), ''); assert.match(document.querySelector('.mcp-error').textContent, /Command is required/);
    await click(control('Remove Search')); await click(save()); assert.deepEqual(saves[1][1].agents[0].mcpServers, []);
  });

  test('MCP edits and deletion stay within the selected agent even when server ids match', async () => {
    const generalServer = { id: 'shared', name: 'General search', command: 'general-server', args: '', enabled: true };
    const reviewServer = { id: 'shared', name: 'Review search', command: 'review-server', args: '', enabled: true };
    const config = { agents: [profile('general', { mcpServers: [generalServer] }), profile('review', { mcpServers: [reviewServer] })] };
    await render({ agentConfig: config }); await section('Agents'); await selectAgent('review');
    assert.equal(control('Server name').value, 'Review search');
    await enterText(document.querySelector('.stdio-fields input'), 'changed-review-server');
    await click(control('Enable Review search'));
    await click(document.querySelector('.agent-list button'));
    assert.equal(control('Server name').value, 'General search');
    assert.equal(document.querySelector('.stdio-fields input').value, 'general-server');
    await click(save());
    assert.equal('mcpServers' in saves[0][0], false);
    assert.deepEqual(saves[0][1].agents[0].mcpServers, [generalServer]);
    assert.deepEqual(saves[0][1].agents[1].mcpServers, [{ ...reviewServer, command: 'changed-review-server', enabled: false }]);
    await click(control('Remove General search')); await click(save());
    assert.deepEqual(saves[1][1].agents[0].mcpServers, []);
    assert.deepEqual(saves[1][1].agents[1].mcpServers, saves[0][1].agents[1].mcpServers);
    assert.deepEqual(config.agents[1].mcpServers, [reviewServer]);
  });

  test('machine removal confirms existing session dependencies while new machines validate required fields', async () => {
    props.settings.hosts = [{ id: 'remote', name: 'Remote', target: 'user@host', piPath: 'pi' }];
    await render({ sessions: [{ hostId: 'remote' }, { hostId: 'remote' }] }); await section('Machines');
    await click(control('Remove Remote')); assert.match(document.querySelector('dialog').textContent, /files and conversations will remain on the remote machine/);
    await click(button('Cancel')); assert.ok(control('Remove Remote'));
    await click(control('Remove Remote')); await click(button('Remove machine')); assert.equal(control('Remove Remote'), null);
    await click(button('Add machine')); await enterText(control('Machine name'), 'Local'); assert.match(document.querySelector('[role=alert]').textContent, /reserved/);
    await enterText(control('Machine name'), 'Build'); await enterText(control('Build SSH target'), 'builder@host'); await enterText(control('Build Piop daemon executable'), '/opt/pi'); await click(save());
    assert.equal(saves[0][0].hosts[0].target, 'builder@host'); assert.equal(saves[0][0].hosts[0].piPath, '/opt/pi');
  });

  test('worktree scripts preserve execution order and use projects on the selected daemon', async () => {
    props.settings.hosts = [{ id: 'remote', name: 'Remote', target: 'host', piPath: 'pi' }];
    await render({ sessions: [{ cwd: '/repo', projectRoot: '/repo' }, { cwd: '/repo/sub', projectRoot: '/repo' }, { cwd: '/remote', hostId: 'remote' }, { cwd: '/skip', projectKind: 'no-repo' }] });
    await section('Worktree scripts'); await click(button('Add script')); await enterText(control('Script 1 name'), 'Install'); await enterText(control('Script 1 project directory'), '/repo');
    await enterText(control('Script 1 setup Bash code'), 'npm ci'); await enterText(control('Script 1 cleanup Bash code'), 'cleanup');
    assert.deepEqual([...document.querySelectorAll('datalist option')].map(option => option.value), ['/repo']);
    assert.equal(control('Script 1 machine'), null);
    await click(button('Add script')); await enterText(control('Script 2 name'), 'Prepare');
    await click([...document.querySelectorAll('.setup-script')][1].querySelectorAll('button')[1]);
    assert.equal(control('Script 1 name').value, 'Prepare'); await click(save());
    assert.deepEqual(saves[0][0].worktreeSetupScripts.map(script => script.name), ['Prepare', 'Install']); assert.equal(saves[0][0].worktreeSetupScripts[1].cleanupScript, 'cleanup');
    await click(button('Remove')); await click(save()); assert.equal(saves[1][0].worktreeSetupScripts.length, 1);
  });

  test('shortcut recording detects collisions, allows clearing, and restores defaults', async () => {
    await render({ scope: 'client' }); await section('Keybinds'); const input = control('New conversation shortcut');
    const key = async (key, extra = {}) => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); await act(async () => input.dispatchEvent(event)); return event; };
    assert.equal((await key('Tab')).defaultPrevented, false); await key('b', { ctrlKey: true }); assert.match(document.querySelector('[role=alert]').textContent, /assigned more than once/);
    await key('Backspace'); assert.equal(input.value, ''); assert.equal(document.querySelector('[role=alert]'), null);
    await key('k', { ctrlKey: true, shiftKey: true }); await click(save()); assert.equal(saves[0][0].keybindings.newConversation, 'Ctrl+Shift+K');
    await click(button('Restore defaults')); await click(save()); assert.deepEqual(saves[1][0].keybindings, defaultKeybindings);
  });

  test('agent edits save defaults, prompts and resource permissions without changing the built-in identity', async () => {
    props.settings.tools = [{ name: 'read', enabled: true }]; props.settings.skills = [{ name: 'Research', path: '/research', enabled: true }];
    await render({ agentConfig: { agents: [profile('general'), profile('review')], fastModeModels: ['p/model'] }, models: [{ provider: 'p', id: 'model', reasoning: true }] });
    await section('Agents'); await selectAgent('review'); assert.equal(control('Agent name').value, 'review');
    await enterText(control('Agent name'), 'code review!'); assert.equal(control('Agent name').value, 'codereview');
    await enterText(control('Agent name'), 'general'); assert.equal(control('Agent name').value, 'codereview');
    await select('Agent default model', 'p/model'); await select('Agent default effort', 'high'); await click(control('Agent fast mode'));
    await enterText(control('System prompt file'), 'review.md'); await enterText(control('Agent prompt file'), 'extra.md');
    for (const label of ['Allow read', 'Allow Research']) await click(control(label));
    await click(control('Allow read')); await click(control('Allow read')); await click(save());
    assert.deepEqual(saves[0][1].agents[1], profile('codereview', { model: 'p/model', effort: 'high', fastMode: true, path_systemprompt: 'review.md', path_agentprompt: 'extra.md', tools: ['read'], skills: ['/research'], mcpServers: [] }));
    await click(document.querySelector('.agent-list button')); assert.equal(control('Agent name').disabled, true); assert.equal(control('Remove general').disabled, true);
  });

  test('renaming and deleting the default agent maintain a valid default and new agents inherit enabled resources', async () => {
    props.settings.defaultAgent = 'review'; props.settings.tools = [{ name: 'read', enabled: true }, { name: 'write', enabled: false }];
    await render({ agentConfig: { agents: [profile('general'), profile('review')] } }); await section('Agents'); await selectAgent('review');
    await enterText(control('Agent name'), 'renamed'); await click(save()); assert.equal(saves[0][0].defaultAgent, 'renamed');
    await click(control('Remove renamed')); await click(save()); assert.equal(saves[1][0].defaultAgent, 'general'); assert.deepEqual(saves[1][1].agents.map(agent => agent.name), ['general']);
    await click(button('Add agent')); assert.equal(control('Allow read').checked, true); assert.equal(control('Allow write').checked, false);
    const firstName = control('Agent name').value; await click(button('Add agent')); assert.notEqual(control('Agent name').value, firstName); await click(save()); assert.equal(saves[2][1].agents.length, 3);
  });

  test('unavailable agent settings block saving until corrected and embedded servers can be removed', async () => {
    await render({ agentConfig: { agents: [profile('general'), profile('review', { model: 'p/missing', effort: 'extreme', mcpServers: [{ id: 'existing', name: 'Existing', command: 'cmd', args: '', enabled: true }] })] }, models: [{ provider: 'p', id: 'model' }], thinkingLevels: ['off', 'high'] });
    await section('Agents'); await selectAgent('review'); assert.match(document.querySelector('[role=alert]').textContent, /model is unavailable/);
    await select('Agent default model', 'p/model'); assert.match(document.querySelector('[role=alert]').textContent, /effort is unavailable/);
    await select('Agent default effort', 'high');
    await enterText(control('System prompt file'), ''); assert.match(document.querySelector('[role=alert]').textContent, /system prompt file is required/);
    await enterText(control('System prompt file'), 'system.md'); await click(control('Agent fast mode')); assert.match(document.querySelector('[role=alert]').textContent, /does not support fast mode/);
    await click(control('Agent fast mode')); await click(control('Remove Existing')); await click(save()); assert.deepEqual(saves[0][1].agents[1].mcpServers, []);
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
});
