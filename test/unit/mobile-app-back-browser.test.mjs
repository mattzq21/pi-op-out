import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startupPage } from '../startup-browser-fixture.mjs';

const settings = { defaultAgent: 'default', hiddenModels: [], defaultThinking: 'high', defaultFastMode: false, contextWindowCap: 200000, contextWindowCapEnabled: true, modelContextWindowCaps: {}, autoRetry: true, debugMode: false, keybindings: { newConversation: 'Ctrl+N', toggleConversations: 'Ctrl+B', toggleTerminal: 'Ctrl+J', toggleDebugMode: 'Ctrl+D', focusComposer: 'Ctrl+E', openSettings: 'Ctrl+,' }, tools: [], skills: [], hosts: [] };
const state = { model: { id: 'model', provider: 'test', name: 'Test model' }, thinkingLevel: 'high', isStreaming: false, sessionId: 'mobile-test', sessionFile: '/tmp/mobile-test.jsonl', messageCount: 0, pendingMessageCount: 0 };

function answerHost(ws) {
  ws.onMessage(raw => {
    const message = JSON.parse(raw);
    if (message.type === 'authenticate') { ws.send(JSON.stringify({ type: 'ready', protocol: 1, backend: 'daemon' })); return; }
    if (message.type === 'ping') return;
    const data = { stop_pi: true, load_app_settings: settings, load_settings_change: { settings }, plugin_status: { enabled: [], configured: [], revision: 'plugins', error: null }, create_temporary_chat: { cwd: '/tmp/project', sessionId: 'mobile-test' }, list_sessions: [], load_session_groups: { version: 1, groups: [], assignments: {} }, codex_usage: { remainingPercent: 80 }, opencode_go_usage: { rolling: { status: 'ok', remainingPercent: 70 }, weekly: { status: 'ok', remainingPercent: 45 }, monthly: { status: 'ok', remainingPercent: 30 } }, start_pi: { attached: true }, home_directory: '/home/test', is_git_repository: false };
    let result = Object.hasOwn(data, message.command) ? data[message.command] : undefined;
    if (message.command === 'provider_auth' && message.args.request.action === 'draft_catalog') result = { config: { agents: [{ name: 'default', model: 'test/model', effort: 'high', path_systemprompt: '', path_agent_prompt: '', tools: [], skills: [], mcpServers: {} }] }, models: [state.model], commands: [] };
    if (message.command === 'pi_command') {
      const responses = { get_session_revision: { revision: 'changed' }, get_snapshot: { revision: 'snapshot', state, history: { entries: [], leafId: null }, queue: { type: 'queue_state', pendingMessages: [] }, liveTools: [], sequence: 0, epoch: 'mobile-test' }, get_state: state, get_available_models: { models: [state.model] }, get_available_thinking_levels: { levels: ['high'] }, get_commands: { commands: [] }, get_session_stats: {} };
      result = responses[message.args.command.type] ?? {};
    }
    if (message.command === 'save_app_settings') result = { settings: message.args.settings };
    ws.send(JSON.stringify(result === undefined ? { id: message.id, error: 'Command is not available on the daemon: ' + message.command } : { id: message.id, result }));
  });
}

// The Android side of the Capacitor bridge: the back button callback and the minimize request.
function androidBridge(initialSettings) {
  const listeners = new Map();
  window.androidMinimized = 0;
  window.pressAndroidBack = () => { for (const callback of listeners.get('backButton') ?? []) callback({ canGoBack: false }); };
  window.Capacitor = {
    PluginHeaders: [
      { name: 'ClientPreferences', methods: [{ name: 'load', rtype: 'promise' }, { name: 'save', rtype: 'promise' }] },
      { name: 'Dictation', methods: [{ name: 'configuration', rtype: 'promise' }, { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
      { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }, { name: 'minimizeApp', rtype: 'promise' }] },
    ],
    nativeCallback: (plugin, method, options, callback) => {
      if (plugin === 'Dictation' && method === 'addListener') return 'dictation-listener';
      if (plugin === 'App' && method === 'addListener') { listeners.set(options.eventName, [...listeners.get(options.eventName) ?? [], callback]); return options.eventName + '-listener'; }
      throw new Error('Unexpected native callback: ' + plugin + '.' + method);
    },
    nativePromise: async (plugin, method, options) => {
      if (plugin === 'Dictation' && method === 'configuration') return { enabled: false, loading: false };
      if (method === 'removeListener') return;
      if (plugin === 'App' && method === 'minimizeApp') { window.androidMinimized++; return; }
      if (plugin === 'ClientPreferences' && method === 'load') return { settings: window.clientPreferences ?? initialSettings, revision: '0' };
      if (plugin === 'ClientPreferences' && method === 'save') { window.clientPreferences = options.settings; return { settings: options.settings, revision: '1', publication: { committed: true, durable: true } }; }
      throw new Error('Unexpected native method: ' + plugin + '.' + method);
    },
  };
}

// Connects the mobile app to the test host and returns the chat with an enabled message box.
async function connectedChat(t) {
  const page = await startupPage(t, 'mobile', {
    entryPoint: fileURLToPath(new URL('../../clients/ui/main.tsx', import.meta.url)), ready: 'input[type="url"]', holdStorage: false,
    async prepare(value) {
      await value.setViewportSize({ width: 390, height: 844 });
      await value.addInitScript(androidBridge, settings);
      await value.routeWebSocket('wss://piop.example.test/', answerHost);
    },
  });
  await page.getByLabel('Anchor host address').fill('wss://piop.example.test');
  await page.getByLabel('Host name').fill('Test workspace');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message piop', exact: true });
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message piop"]')?.disabled === false);
  return { page, editor };
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('Android Back on unsaved settings asks first and returns to the chat draft only after discard', async t => {
  const { page, editor } = await connectedChat(t);
  await editor.fill('Keep this draft');
  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Client settings', exact: true }).waitFor();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Test workspace', exact: true }).click();
  const retry = page.getByRole('switch', { name: 'Automatic retry', exact: true });
  await retry.click();
  assert.equal(await retry.getAttribute('aria-checked'), 'false');
  const prompts = [];

  page.once('dialog', dialog => { prompts.push(dialog.message()); return dialog.dismiss(); });
  await page.evaluate(() => window.pressAndroidBack());
  await settle(page);
  assert.deepEqual(prompts, ['Discard unsaved settings changes?']);
  assert.equal(await retry.isVisible(), true);
  assert.equal(await retry.getAttribute('aria-checked'), 'false');
  assert.equal(await page.evaluate(() => window.androidMinimized), 0);

  page.once('dialog', dialog => { prompts.push(dialog.message()); return dialog.accept(); });
  await page.evaluate(() => window.pressAndroidBack());
  await editor.waitFor();
  await settle(page);
  assert.deepEqual(prompts, ['Discard unsaved settings changes?', 'Discard unsaved settings changes?']);
  assert.equal(await retry.count(), 0);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.androidMinimized), 0);
});

test('Android Back closes the open conversation panel first and minimizes the app only on the next press', async t => {
  const { page, editor } = await connectedChat(t);
  await editor.fill('Keep this draft');
  const closePanel = page.getByRole('button', { name: 'Close conversations', exact: true });
  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  await closePanel.waitFor();

  await page.evaluate(() => window.pressAndroidBack());
  await closePanel.waitFor({ state: 'detached' });
  await settle(page);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.androidMinimized), 0);

  await page.evaluate(() => window.pressAndroidBack());
  await page.waitForFunction(() => window.androidMinimized > 0);
  await settle(page);
  assert.equal(await page.evaluate(() => window.androidMinimized), 1);
  assert.equal(await closePanel.count(), 0);
  assert.equal(await editor.inputValue(), 'Keep this draft');
});

