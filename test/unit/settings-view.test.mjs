import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { SettingsView } from '../../src/components/SettingsView.tsx';
import { defaultKeybindings } from '../../src/lib/keybindings.ts';

describe('settings editor', () => {
  let dom, view, props, saves, dirty;
  beforeEach(() => {
    dom = installDom(); saves = []; dirty = [];
    props = { settings: { worktreeSetupScripts: [], defaultAgent: 'general', defaultModel: 'p/model', hiddenModels: [], defaultThinking: 'off', defaultFastMode: false, contextWindowCap: 10000, contextWindowCapEnabled: true, autoCompaction: true, autoRetry: true, debugMode: false, keybindings: { ...defaultKeybindings }, tools: [], skills: [], mcpServers: [], hosts: [], dictionaries: [], activeDictionaryIds: [] }, onSave: async (...args) => saves.push(args), onDirtyChange: value => dirty.push(value) };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });
  async function render(extra = {}) { props = { ...props, ...extra }; if (view) await view.rerender(props); else view = await renderComponent(SettingsView, props); }
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const click = async element => act(async () => element.click());
  const save = () => document.querySelector('.settings-save button');
  const section = async name => click([...document.querySelectorAll('nav button')].find(item => item.textContent === name));
  const select = async (label, value) => act(async () => { control(label).value = value; control(label).dispatchEvent(new Event('change', { bubbles: true })); });
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
    await enterText(control('Context window cap'), '999'); assert.equal(save().disabled, true); assert.match(document.querySelector('[role=alert]').textContent, /at least 1000/);
    await enterText(control('Context window cap'), '2000'); await click(save()); assert.equal(document.querySelector('[role=alert]').textContent, 'disk full'); assert.equal(save().disabled, false);
    await click(control('Automatic retry')); assert.equal(document.querySelector('[role=alert]'), null);
    await click(control('Enable context window cap')); assert.equal(control('Context window cap').disabled, true);
  });

  test('model visibility retains unavailable models and supports filtering and toggling visibility', async () => {
    props.settings.hiddenModels = ['old/missing'];
    await render({ models: [{ provider: 'p', id: 'model', name: 'Current' }] });
    await section('Models');
    assert.match(document.body.textContent, /Currently unavailable/); assert.equal(control('Show old/missing').getAttribute('aria-checked'), 'false');
    await click(control('Show p/model')); await click(save()); assert.deepEqual(saves[0][0].hiddenModels, ['old/missing', 'p/model']);
    await enterText(control('Filter models'), 'absent'); assert.match(document.body.textContent, /No models match/);
    await enterText(control('Filter models'), '');
    await click(control('Show old/missing')); await click(control('Show p/model'));
    await click(save()); assert.deepEqual(saves[1][0].hiddenModels, []);
  });

  test('dictionary editing validates active entries and removes inactive references on deletion', async () => {
    await render(); await section('Dictionaries'); await click(button('Add dictionary'));
    await enterText(control('Dictionary name'), 'Glossary'); await click(control('Enable Glossary')); await click(button('Add word'));
    assert.match(document.querySelector('[role=alert]').textContent, /both a word and replacement/);
    await enterText(control('Word 1'), 'api'); await enterText(control('Replacement 1'), 'interface');
    await click(button('Add word')); await enterText(control('Word 2'), 'api'); await enterText(control('Replacement 2'), 'duplicate');
    assert.match(document.querySelector('[role=alert]').textContent, /appears more than once/); assert.equal(control('Word 1').getAttribute('aria-invalid'), 'true');
    await click(control('Remove entry 2')); await click(save());
    assert.deepEqual(saves[0][0].dictionaries[0].entries, [{ word: 'api', replacement: 'interface' }]); assert.equal(saves[0][0].activeDictionaryIds[0], saves[0][0].dictionaries[0].id);
    await click(control('Remove Glossary')); await click(save()); assert.deepEqual(saves[1][0].dictionaries, []); assert.deepEqual(saves[1][0].activeDictionaryIds, []);
  });

  test('MCP HTTP validation rejects bad URLs, headers and timeouts before saving', async () => {
    await render(); await section('MCP servers'); await click(button('Add MCP server')); await enterText(control('Server name'), 'Search');
    await click(button('HTTP')); const fields = () => document.querySelectorAll('.http-fields input');
    assert.match(document.querySelector('.mcp-error').textContent, /valid HTTP URL/);
    await enterText(fields()[0], 'file:///tmp/x'); assert.match(document.querySelector('.mcp-error').textContent, /HTTP or HTTPS/);
    await enterText(fields()[0], 'https://example.com/mcp');
    for (const [headers, error] of [['{bad', 'valid JSON'], ['[]', 'string values'], ['{"a":3}', 'string values'], ['null', 'string values']]) { await enterText(fields()[1], headers); assert.match(document.querySelector('.mcp-error').textContent, new RegExp(error)); }
    await enterText(fields()[1], '{"Authorization":"test"}'); await enterText(control('Search startup timeout'), '0'); assert.match(document.querySelector('.mcp-error').textContent, /between 1 and 600/);
    await enterText(control('Search startup timeout'), '20'); await click(save()); assert.equal(saves[0][0].mcpServers[0].startupTimeoutSec, 20); assert.equal(saves[0][0].mcpServers[0].url, 'https://example.com/mcp');
    await click(button('stdio')); await enterText(document.querySelector('.stdio-fields input'), ''); assert.match(document.querySelector('.mcp-error').textContent, /Command is required/);
    await click(control('Remove Search')); await click(save()); assert.deepEqual(saves[1][0].mcpServers, []);
  });

  test('machine removal confirms existing session dependencies while new machines validate required fields', async () => {
    props.settings.hosts = [{ id: 'remote', name: 'Remote', target: 'user@host', piPath: 'pi' }];
    const confirmations = []; window.confirm = message => { confirmations.push(message); return false; };
    await render({ sessions: [{ hostId: 'remote' }, { hostId: 'remote' }] }); await section('Machines');
    await click(control('Remove Remote')); assert.match(confirmations[0], /2 indexed conversations depend/); assert.ok(control('Remove Remote'));
    window.confirm = () => true; await click(control('Remove Remote')); assert.equal(control('Remove Remote'), null);
    await click(button('Add machine')); await enterText(control('Machine name'), 'Local'); assert.match(document.querySelector('[role=alert]').textContent, /reserved/);
    await enterText(control('Machine name'), 'Build'); await enterText(control('Build SSH target'), 'builder@host'); await enterText(control('Build Pi executable'), '/opt/pi'); await click(save());
    assert.equal(saves[0][0].hosts[0].target, 'builder@host'); assert.equal(saves[0][0].hosts[0].piPath, '/opt/pi');
  });

  test('worktree scripts preserve execution order and clear project paths when machines change', async () => {
    props.settings.hosts = [{ id: 'remote', name: 'Remote', target: 'host', piPath: 'pi' }];
    await render({ sessions: [{ cwd: '/repo', projectRoot: '/repo' }, { cwd: '/repo/sub', projectRoot: '/repo' }, { cwd: '/remote', hostId: 'remote' }, { cwd: '/skip', projectKind: 'no-repo' }] });
    await section('Worktree scripts'); await click(button('Add script')); await enterText(control('Script 1 name'), 'Install'); await enterText(control('Script 1 project directory'), '/repo');
    await enterText(control('Script 1 setup Bash code'), 'npm ci'); await enterText(control('Script 1 cleanup Bash code'), 'cleanup');
    assert.deepEqual([...document.querySelectorAll('datalist option')].map(option => option.value), ['/repo']);
    await select('Script 1 machine', 'remote'); assert.equal(control('Script 1 project directory').value, ''); assert.deepEqual([...document.querySelectorAll('datalist option')].map(option => option.value), ['/remote']);
    await enterText(control('Script 1 project directory'), '/remote'); await click(button('Add script')); await enterText(control('Script 2 name'), 'Prepare');
    await click([...document.querySelectorAll('.setup-script')][1].querySelectorAll('button')[1]);
    assert.equal(control('Script 1 name').value, 'Prepare'); await click(save());
    assert.deepEqual(saves[0][0].worktreeSetupScripts.map(script => script.name), ['Prepare', 'Install']); assert.equal(saves[0][0].worktreeSetupScripts[1].cleanupScript, 'cleanup');
    await click(button('Remove')); await click(save()); assert.equal(saves[1][0].worktreeSetupScripts.length, 1);
  });

  test('shortcut recording detects collisions, allows clearing, and restores defaults', async () => {
    await render(); await section('Keybinds'); const input = control('New conversation shortcut');
    const key = async (key, extra = {}) => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); await act(async () => input.dispatchEvent(event)); return event; };
    assert.equal((await key('Tab')).defaultPrevented, false); await key('b', { ctrlKey: true }); assert.match(document.querySelector('[role=alert]').textContent, /assigned more than once/);
    await key('Backspace'); assert.equal(input.value, ''); assert.equal(document.querySelector('[role=alert]'), null);
    await key('k', { ctrlKey: true, shiftKey: true }); await click(save()); assert.equal(saves[0][0].keybindings.newConversation, 'Ctrl+Shift+K');
    await click(button('Restore defaults')); await click(save()); assert.deepEqual(saves[1][0].keybindings, defaultKeybindings);
  });

  test('agent edits save defaults, prompts and resource permissions without changing the built-in identity', async () => {
    props.settings.tools = [{ name: 'read', enabled: true }]; props.settings.skills = [{ name: 'Research', path: '/research', enabled: true }]; props.settings.mcpServers = [{ id: 'search', name: 'Search', command: 'search', args: '', enabled: true }];
    await render({ agentConfig: { agents: [profile('general'), profile('review')], fastModeModels: ['p/model'] }, models: [{ provider: 'p', id: 'model' }] });
    await section('Agents'); assert.equal(control('Agent name').value, 'review');
    await enterText(control('Agent name'), 'code review!'); assert.equal(control('Agent name').value, 'codereview');
    await enterText(control('Agent name'), 'general'); assert.equal(control('Agent name').value, 'codereview');
    await select('Agent default model', 'p/model'); await select('Agent default effort', 'high'); await click(control('Agent fast mode'));
    await enterText(control('System prompt file'), 'review.md'); await enterText(control('Agent prompt file'), 'extra.md');
    for (const label of ['Allow read', 'Allow Research', 'Allow Search']) await click(control(label));
    await click(control('Allow read')); await click(control('Allow read')); await click(save());
    assert.deepEqual(saves[0][1].agents[1], profile('codereview', { model: 'p/model', effort: 'high', fastMode: true, path_systemprompt: 'review.md', path_agentprompt: 'extra.md', tools: ['read'], skills: ['/research'], mcpServers: ['search'] }));
    await click(document.querySelector('.agent-list button')); assert.equal(control('Agent name').disabled, true); assert.equal(control('Remove general').disabled, true);
  });

  test('renaming and deleting the default agent maintain a valid default and new agents inherit enabled resources', async () => {
    props.settings.defaultAgent = 'review'; props.settings.tools = [{ name: 'read', enabled: true }, { name: 'write', enabled: false }];
    await render({ agentConfig: { agents: [profile('general'), profile('review')] } }); await section('Agents');
    await enterText(control('Agent name'), 'renamed'); await click(save()); assert.equal(saves[0][0].defaultAgent, 'renamed');
    await click(control('Remove renamed')); await click(save()); assert.equal(saves[1][0].defaultAgent, 'general'); assert.deepEqual(saves[1][1].agents.map(agent => agent.name), ['general']);
    await click(button('Add agent')); assert.equal(control('Allow read').checked, true); assert.equal(control('Allow write').checked, false);
    const firstName = control('Agent name').value; await click(button('Add agent')); assert.notEqual(control('Agent name').value, firstName); await click(save()); assert.equal(saves[2][1].agents.length, 3);
  });

  test('unavailable agent resources block saving until corrected and server deletion removes references', async () => {
    props.settings.mcpServers = [{ id: 'existing', name: 'Existing', command: 'cmd', args: '' }];
    await render({ agentConfig: { agents: [profile('general'), profile('review', { model: 'p/missing', effort: 'extreme', mcpServers: ['gone', 'existing'] })] }, models: [{ provider: 'p', id: 'model' }], thinkingLevels: ['off', 'high'] });
    await section('Agents'); assert.match(document.querySelector('[role=alert]').textContent, /model is unavailable/);
    await select('Agent default model', 'p/model'); assert.match(document.querySelector('[role=alert]').textContent, /effort is unavailable/);
    await select('Agent default effort', 'high'); assert.match(document.querySelector('[role=alert]').textContent, /remove unavailable MCP server/);
    await click(control('Remove unavailable MCP server gone')); await enterText(control('System prompt file'), ''); assert.match(document.querySelector('[role=alert]').textContent, /system prompt file is required/);
    await enterText(control('System prompt file'), 'system.md'); await click(control('Agent fast mode')); assert.match(document.querySelector('[role=alert]').textContent, /does not support fast mode/);
    await click(control('Agent fast mode')); await section('MCP servers'); await click(control('Remove Existing')); await click(save()); assert.deepEqual(saves[0][1].agents[1].mcpServers, []);
  });

  test('late configuration discovery preserves general edits and leaves existing agent edits intact', async () => {
    await render(); await click(control('Automatic retry'));
    await render({ agentConfig: { agents: [profile('general'), profile('discovered')] } }); await section('Agents'); assert.equal(control('Agent name').value, 'discovered');
    await click(save()); assert.equal(saves[0][0].autoRetry, false); assert.equal(saves[0][1], undefined);
    await enterText(control('Agent name'), 'edited');
    await render({ agentConfig: { agents: [profile('general'), profile('external')] } }); assert.equal(control('Agent name').value, 'edited');
    await click(save()); assert.equal(saves[1][1].agents[1].name, 'edited');
  });

  test('configuration refresh during save keeps agent capabilities until completion', async () => {
    const pending = Promise.withResolvers();
    await render({ agentConfig: { agents: [profile('general'), profile('review')] }, onSave: () => pending.promise }); await section('Agents'); await enterText(control('Agent prompt file'), 'new.md'); await click(save());
    await render({ agentConfig: undefined }); assert.ok(control('Agent name')); assert.equal(control('Agent prompt file').value, 'new.md');
    await act(async () => pending.resolve()); assert.equal(control('Agent name'), null); assert.ok(control('Automatic retry'));
  });
});
