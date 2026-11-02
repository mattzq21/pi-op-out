import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startupPage } from '../startup-browser-fixture.mjs';

const settings = { hiddenModels: [], defaultThinking: 'high', defaultFastMode: false, contextWindowCap: 200000, contextWindowCapEnabled: true, modelContextWindowCaps: {}, autoRetry: true, hiddenUsageIndicators: [], debugMode: false, keybindings: { newConversation: 'Ctrl+N', toggleConversations: 'Ctrl+B', toggleTerminal: 'Ctrl+J', toggleDebugMode: 'Ctrl+D', focusComposer: 'Ctrl+E', openSettings: 'Ctrl+,', toggleQueueHold: 'Ctrl+H' }, tools: [], skills: [], hosts: [] };
const state = { model: { id: 'model', provider: 'test', name: 'Test model' }, thinkingLevel: 'high', isStreaming: false, sessionId: 'mobile-test', sessionFile: '/tmp/mobile-test.jsonl', messageCount: 0, pendingMessageCount: 0 };
const data = { settings_pending_count: 0, stop_pi: true, load_app_settings: settings, load_settings_change: { settings }, plugin_status: { enabled: [], configured: [], revision: 'plugins', error: null }, create_temporary_chat: { cwd: '/tmp/project', sessionId: 'mobile-test' }, list_sessions: [], load_session_groups: { version: 1, groups: [], assignments: {} }, provider_usage: {}, start_pi: { attached: true }, home_directory: '/home/test', is_git_repository: false };
const piResponses = { get_session_revision: { revision: 'changed' }, get_snapshot: { revision: 'snapshot', state, history: { entries: [], leafId: null }, queue: { type: 'queue_state', pendingMessages: [] }, liveTools: [], sequence: 0, epoch: 'mobile-test' }, get_state: state, get_available_models: { models: [state.model] }, get_available_thinking_levels: { levels: ['high'] }, get_commands: { commands: [] }, get_session_stats: {} };

function result(message) {
  if (message.command === 'provider_auth') return message.args.request.action === 'fast_models' ? { ready: true, providers: {} } : { config: { agents: [{ name: 'default', isDefault: true, model: 'test/model', effort: 'high', path_systemprompt: '', path_agent_prompt: '', tools: [], skills: [], mcpServers: {} }] }, models: [state.model], initialModel: null, initialThinking: 'medium', commands: [], commandDetails: [], skills: [] };
  if (message.command === 'pi_command') return piResponses[message.args.command.type] ?? {};
  if (message.command === 'save_app_settings') return { settings: message.args.settings };
  return data[message.command];
}

function preferences(initialSettings) {
  window.Capacitor = {
    PluginHeaders: [{ name: 'ClientPreferences', methods: [{ name: 'load', rtype: 'promise' }, { name: 'save', rtype: 'promise' }] }],
    nativeCallback: (plugin, method) => { throw new Error('Unexpected native callback: ' + plugin + '.' + method); },
    nativePromise: async (plugin, method, options) => {
      if (plugin === 'ClientPreferences' && method === 'load') return { settings: window.clientPreferences ?? initialSettings, revision: '0' };
      if (plugin === 'ClientPreferences' && method === 'save') { window.clientPreferences = options.settings; return { settings: options.settings, revision: '1', publication: { committed: true, durable: true } }; }
      throw new Error('Unexpected native method: ' + plugin + '.' + method);
    },
  };
}

test('background load toasts from a dropped reconnect close when the next reconnect loads them', async t => {
  const held = ['list_sessions', 'settings_pending_count'];
  const sockets = [];
  let heldSeen;
  const heldRequests = new Promise(resolve => { heldSeen = resolve; });
  let reloaded;
  const reloadedRequests = new Promise(resolve => { reloaded = resolve; });
  const page = await startupPage(t, 'mobile', {
    entryPoint: fileURLToPath(new URL('../../clients/ui/main.tsx', import.meta.url)), ready: 'input[type="url"]', holdStorage: false,
    async prepare(value) {
      await value.setViewportSize({ width: 390, height: 844 });
      await value.addInitScript(preferences, settings);
      await value.routeWebSocket('wss://piop.example.test/', ws => {
        const connection = sockets.push(ws);
        const seen = new Set();
        ws.onMessage(raw => {
          const message = JSON.parse(raw);
          if (message.type === 'authenticate') { ws.send(JSON.stringify({ type: 'ready', protocol: 1, backend: 'daemon' })); return; }
          if (message.type === 'ping') return;
          if (held.includes(message.command)) seen.add(message.command);
          if (connection === 2 && held.includes(message.command)) { if (seen.size === held.length) heldSeen(); return; }
          const value = result(message);
          ws.send(JSON.stringify(value === undefined ? { id: message.id, error: 'Command is not available on the daemon: ' + message.command } : { id: message.id, result: value }));
          if (connection === 3 && seen.size === held.length) reloaded();
        });
      });
    },
  });
  const toasts = page.locator('.error-toast');
  await page.getByLabel('Anchor host address').fill('wss://piop.example.test');
  await page.getByLabel('Host name').fill('Test workspace');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message piop', exact: true }).waitFor();

  sockets[0].close();
  await heldRequests;
  sockets[1].close();
  await toasts.filter({ hasText: 'Could not load chats' }).waitFor();
  await toasts.filter({ hasText: 'Could not read which sessions still apply saved settings' }).waitFor();

  await reloadedRequests;
  await page.waitForFunction(() => document.querySelectorAll('.error-toast').length === 0, undefined, { timeout: 5000 }).catch(() => undefined);
  assert.deepEqual(await toasts.allInnerTexts(), []);
});
