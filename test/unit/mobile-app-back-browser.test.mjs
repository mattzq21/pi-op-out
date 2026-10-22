import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startupPage } from '../startup-browser-fixture.mjs';

const settings = { hiddenModels: [], defaultThinking: 'high', defaultFastMode: false, contextWindowCap: 200000, contextWindowCapEnabled: true, modelContextWindowCaps: {}, autoRetry: true, debugMode: false, keybindings: { newConversation: 'Ctrl+N', toggleConversations: 'Ctrl+B', toggleTerminal: 'Ctrl+J', toggleDebugMode: 'Ctrl+D', focusComposer: 'Ctrl+E', openSettings: 'Ctrl+,' }, tools: [], skills: [], hosts: [] };
const state = { model: { id: 'model', provider: 'test', name: 'Test model' }, thinkingLevel: 'high', isStreaming: false, sessionId: 'mobile-test', sessionFile: '/tmp/mobile-test.jsonl', messageCount: 0, pendingMessageCount: 0 };

// Test controls: `host.stopFailure` makes the host refuse to stop agent runs with this error; `host.stopHeld` is a promise that delays every stop reply until it resolves; `host.received` collects every request the host gets, and `host.onRequest` sees each one.
function answerHost(ws, host) {
  ws.onMessage(raw => {
    const message = JSON.parse(raw);
    host.received?.push(message);
    host.onRequest?.(message);
    if (message.command === 'stop_pi' && host.stopHeld) { void host.stopHeld.then(() => reply(ws, host, message)); return; }
    reply(ws, host, message);
  });
}

function reply(ws, host, message) {
  if (message.type === 'authenticate') { ws.send(JSON.stringify({ type: 'ready', protocol: 1, backend: 'daemon' })); return; }
  if (message.type === 'ping') return;
  if (message.command === 'stop_pi' && host.stopFailure) { ws.send(JSON.stringify({ id: message.id, error: host.stopFailure })); return; }
  const data = { stop_pi: true, load_app_settings: settings, load_settings_change: { settings }, plugin_status: { enabled: [], configured: [], revision: 'plugins', error: null }, create_temporary_chat: { cwd: '/tmp/project', sessionId: 'mobile-test' }, list_sessions: [], load_session_groups: { version: 1, groups: [], assignments: {} }, codex_usage: { remainingPercent: 80 }, opencode_go_usage: { rolling: { status: 'ok', remainingPercent: 70 }, weekly: { status: 'ok', remainingPercent: 45 }, monthly: { status: 'ok', remainingPercent: 30 } }, start_pi: { attached: true }, home_directory: '/home/test', is_git_repository: false };
  let result = Object.hasOwn(data, message.command) ? data[message.command] : undefined;
  if (message.command === 'provider_auth' && message.args.request.action === 'fast_models') result = { ready: true, providers: {} };
  if (message.command === 'provider_auth' && message.args.request.action === 'draft_catalog') result = { config: { agents: [{ name: 'default', isDefault: true, model: 'test/model', effort: 'high', path_systemprompt: '', path_agent_prompt: '', tools: [], skills: [], mcpServers: {} }] }, models: [state.model], initialModel: null, initialThinking: 'medium', commands: [], commandDetails: [] };
  if (message.command === 'pi_command') {
    const responses = { get_session_revision: { revision: 'changed' }, get_snapshot: { revision: 'snapshot', state, history: { entries: [], leafId: null }, queue: { type: 'queue_state', pendingMessages: [] }, liveTools: [], sequence: 0, epoch: 'mobile-test' }, get_state: state, get_available_models: { models: [state.model] }, get_available_thinking_levels: { levels: ['high'] }, get_commands: { commands: [] }, get_session_stats: {} };
    result = responses[message.args.command.type] ?? {};
  }
  if (message.command === 'save_app_settings') result = { settings: message.args.settings };
  if (message.command === 'list_directories') result = { path: message.args.path ?? '/home/test', parent: '/home', directories: [] };
  ws.send(JSON.stringify(result === undefined ? { id: message.id, error: 'Command is not available on the daemon: ' + message.command } : { id: message.id, result }));
}

// The Android side of the Capacitor bridge: the back button callback and the minimize request.
function androidBridge(initialSettings) {
  const listeners = new Map();
  window.androidMinimized = 0;
  window.androidMinimizeAttempts = 0;
  // Test control: the next minimize request fails with this native error message.
  window.failNextAndroidMinimize = undefined;
  window.pressAndroidBack = () => { for (const callback of listeners.get('backButton') ?? []) callback({ canGoBack: false }); };
  window.Capacitor = {
    PluginHeaders: [
      { name: 'ClientPreferences', methods: [{ name: 'load', rtype: 'promise' }, { name: 'save', rtype: 'promise' }] },
      { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }, { name: 'minimizeApp', rtype: 'promise' }] },
    ],
    nativeCallback: (plugin, method, options, callback) => {
      if (plugin === 'App' && method === 'addListener') { listeners.set(options.eventName, [...listeners.get(options.eventName) ?? [], callback]); return options.eventName + '-listener'; }
      throw new Error('Unexpected native callback: ' + plugin + '.' + method);
    },
    nativePromise: async (plugin, method, options) => {
      if (method === 'removeListener') return;
      if (plugin === 'App' && method === 'minimizeApp') {
        window.androidMinimizeAttempts++;
        const failure = window.failNextAndroidMinimize;
        window.failNextAndroidMinimize = undefined;
        if (failure) throw new Error(failure);
        window.androidMinimized++; return;
      }
      if (plugin === 'ClientPreferences' && method === 'load') return { settings: window.clientPreferences ?? initialSettings, revision: '0' };
      if (plugin === 'ClientPreferences' && method === 'save') { window.clientPreferences = options.settings; return { settings: options.settings, revision: '1', publication: { committed: true, durable: true } }; }
      throw new Error('Unexpected native method: ' + plugin + '.' + method);
    },
  };
}

// Connects the mobile app to the test host and returns the chat with an enabled message box.
async function connectedChat(t, host = {}) {
  const page = await startupPage(t, 'mobile', {
    entryPoint: fileURLToPath(new URL('../../clients/ui/main.tsx', import.meta.url)), ready: 'input[type="url"]', holdStorage: false,
    async prepare(value) {
      await value.setViewportSize({ width: 390, height: 844 });
      await value.addInitScript(androidBridge, settings);
      await value.routeWebSocket('wss://piop.example.test/', ws => answerHost(ws, host));
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

test('Android Back shows the native minimize failure, and the next Back after recovery minimizes the app and clears the failure', async t => {
  const { page, editor } = await connectedChat(t);
  await editor.fill('Keep this draft');
  await page.evaluate(() => { window.failNextAndroidMinimize = 'Activity is not available'; });
  const failure = page.getByRole('status').filter({ hasText: 'Activity is not available' });

  await page.evaluate(() => window.pressAndroidBack());
  await failure.waitFor();
  await settle(page);
  assert.equal(await page.evaluate(() => window.androidMinimizeAttempts), 1);
  assert.equal(await page.evaluate(() => window.androidMinimized), 0);
  assert.equal(await editor.inputValue(), 'Keep this draft');

  await page.evaluate(() => window.pressAndroidBack());
  await page.waitForFunction(() => window.androidMinimized > 0);
  await settle(page);
  assert.equal(await page.evaluate(() => window.androidMinimizeAttempts), 2);
  assert.equal(await page.evaluate(() => window.androidMinimized), 1);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  assert.equal(await page.getByText('Activity is not available').count(), 0);
});

test('a successful Android minimize clears only its own failure and keeps the refused disconnect error', async t => {
  const host = {};
  const { page, editor } = await connectedChat(t, host);
  await editor.fill('Keep this draft');
  const minimizeFailure = page.locator('.mobile-reconnect-banner').filter({ hasText: 'Activity is not available' });
  const connectionNotice = page.locator('.mobile-reconnect-banner').filter({ hasText: 'Agent run could not stop' });
  const retryDisconnect = connectionNotice.getByRole('button', { name: 'Retry disconnect', exact: true });

  await page.evaluate(() => { window.failNextAndroidMinimize = 'Activity is not available'; });
  await page.evaluate(() => window.pressAndroidBack());
  await minimizeFailure.waitFor();

  host.stopFailure = 'Agent run could not stop';
  const closePanel = page.getByRole('button', { name: 'Close conversations', exact: true });
  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Host', exact: true }).click();
  await retryDisconnect.waitFor();
  await page.evaluate(() => window.pressAndroidBack());
  await closePanel.waitFor({ state: 'detached' });
  await settle(page);
  assert.equal(await page.evaluate(() => window.androidMinimizeAttempts), 1);
  assert.equal(await minimizeFailure.isVisible(), true);
  assert.equal(await connectionNotice.isVisible(), true);
  const [minimizeBox, connectionBox] = [await minimizeFailure.boundingBox(), await connectionNotice.boundingBox()];
  const overlap = minimizeBox.x < connectionBox.x + connectionBox.width && connectionBox.x < minimizeBox.x + minimizeBox.width && minimizeBox.y < connectionBox.y + connectionBox.height && connectionBox.y < minimizeBox.y + minimizeBox.height;
  assert.equal(overlap, false, 'The minimize failure covers the connection notice: ' + JSON.stringify({ minimizeBox, connectionBox }));

  await page.evaluate(() => window.pressAndroidBack());
  await page.waitForFunction(() => window.androidMinimized > 0);
  await settle(page);
  assert.equal(await page.evaluate(() => window.androidMinimizeAttempts), 2);
  assert.equal(await minimizeFailure.count(), 0);
  assert.equal(await connectionNotice.isVisible(), true);
  assert.equal(await retryDisconnect.isEnabled(), true);
  assert.equal(await editor.isVisible(), true);
});

test('Retry disconnect after the host recovers from a refused stop shows the connection form with the saved host', async t => {
  const host = { stopFailure: 'Agent run could not stop' };
  const { page, editor } = await connectedChat(t, host);
  await editor.fill('Keep this draft');
  const connectionNotice = page.locator('.mobile-reconnect-banner').filter({ hasText: 'Agent run could not stop' });
  const retryDisconnect = connectionNotice.getByRole('button', { name: 'Retry disconnect', exact: true });
  const prompts = [];
  page.on('dialog', dialog => { prompts.push(dialog.message()); return dialog.accept(); });

  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  await page.getByRole('button', { name: 'Host', exact: true }).click();
  await retryDisconnect.waitFor();
  await settle(page);
  assert.equal(await editor.isVisible(), true);
  assert.equal(await retryDisconnect.isEnabled(), true);
  assert.equal(prompts.length, 1);

  host.stopFailure = undefined;
  await retryDisconnect.click();
  const address = page.getByLabel('Anchor host address');
  await address.waitFor();
  await settle(page);
  assert.equal(prompts.length, 2);
  assert.equal(await editor.count(), 0);
  assert.equal(await page.getByText('Agent run could not stop').count(), 0);
  assert.equal(await address.inputValue(), 'wss://piop.example.test/');
  assert.equal(await page.getByLabel('Host name').inputValue(), 'Test workspace');
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true);
});

test('cancelling Disconnect from the Host button keeps the draft and a working chat without stopping the agent', async t => {
  const host = { received: [] };
  const { page, editor } = await connectedChat(t, host);
  await editor.fill('Keep this draft');
  const prompts = [];
  page.once('dialog', dialog => { prompts.push(dialog.message()); return dialog.dismiss(); });
  const stops = () => host.received.filter(message => message.command === 'stop_pi');

  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  const stopsBeforeHost = stops().length;
  await page.getByRole('button', { name: 'Host', exact: true }).click();
  await settle(page);
  assert.deepEqual(prompts, ['Disconnect? Draft messages, interrupted messages, attachments, and unsaved settings will be discarded.']);
  assert.equal(stops().length, stopsBeforeHost);
  assert.equal(await page.getByLabel('Anchor host address').count(), 0);
  assert.equal(await editor.inputValue(), 'Keep this draft');

  await page.evaluate(() => window.pressAndroidBack());
  await page.getByRole('button', { name: 'Close conversations', exact: true }).waitFor({ state: 'detached' });
  await editor.click();
  await editor.press('End');
  await page.keyboard.type(' and send it');
  assert.equal(await editor.inputValue(), 'Keep this draft and send it');
  const received = new Promise(resolve => { host.onRequest = message => { if (message.command === 'pi_command' && message.args.command.type === 'prompt') resolve(message); }; });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const sent = await received;
  assert.equal(sent.args.command.message, 'Keep this draft and send it');
  assert.equal(stops().some(message => message.args.runtimeId === sent.args.runtimeId), false);
  assert.equal(await page.getByLabel('Anchor host address').count(), 0);
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

test('Android Back over the project folder dialog cancels only the dialog, then closes the conversation panel under it', async t => {
  const { page, editor } = await connectedChat(t);
  await editor.fill('Keep this draft');
  const closePanel = page.getByRole('button', { name: 'Close conversations', exact: true });
  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  await closePanel.waitFor();
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Group name', exact: true }) }).getByRole('button', { name: 'Choose project', exact: true }).click();
  const folderDialog = page.getByRole('dialog', { name: 'Jump to a folder', exact: true });
  await folderDialog.waitFor();
  await page.getByRole('button', { name: /Open current folder/ }).and(page.locator(':enabled')).waitFor();

  await page.evaluate(() => window.pressAndroidBack());
  await folderDialog.waitFor({ state: 'detached' });
  await settle(page);
  assert.equal(await closePanel.isVisible(), true);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.androidMinimized), 0);

  await page.evaluate(() => window.pressAndroidBack());
  await closePanel.waitFor({ state: 'detached' });
  await settle(page);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.androidMinimized), 0);
});

test('a held disconnect stop locks the chat and Host, and a refused stop gives back the draft', async t => {
  let settingsStopAsked;
  const settingsStop = new Promise(resolve => { settingsStopAsked = resolve; });
  const host = { received: [], onRequest: message => { if (message.command === 'stop_pi') settingsStopAsked(); } };
  const { page, editor } = await connectedChat(t, host);
  await editor.fill('Keep this draft');
  await settingsStop;
  let releaseStop;
  Object.assign(host, { stopHeld: new Promise(resolve => { releaseStop = resolve; }), stopFailure: 'Agent run could not stop' });
  const prompts = [];
  page.on('dialog', dialog => { prompts.push(dialog.message()); return dialog.accept(); });
  const stops = () => host.received.filter(message => message.command === 'stop_pi');
  const sent = () => host.received.filter(message => message.command === 'pi_command' && message.args.command.type === 'prompt');
  const editorFocused = () => page.evaluate(() => document.activeElement === document.querySelector('textarea[aria-label="Message piop"]'));
  const clickCenter = box => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hostDisabled = () => page.evaluate(() => document.querySelector('button[aria-label="Disconnect from anchor host"]').disabled);
  const [editorBox, sendBox] = [await editor.boundingBox(), await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()];
  const stopAsked = new Promise(resolve => { host.onRequest = message => { if (message.command === 'stop_pi') resolve(); }; });

  await page.getByRole('button', { name: 'Toggle conversations' }).click();
  const hostButton = page.getByRole('button', { name: 'Host', exact: true });
  const hostBox = await hostButton.boundingBox();
  await hostButton.click();
  await stopAsked;
  await settle(page);
  const heldStops = stops().length;
  assert.equal(prompts.length, 1);
  assert.equal(await hostDisabled(), true);

  await clickCenter(hostBox);
  await page.keyboard.press('Enter');
  await settle(page);
  assert.equal(prompts.length, 1);
  assert.equal(stops().length, heldStops);
  await page.evaluate(() => window.pressAndroidBack());
  await page.getByRole('button', { name: 'Close conversations', exact: true }).waitFor({ state: 'detached' });
  await clickCenter(editorBox);
  assert.equal(await editorFocused(), false);
  await page.keyboard.press('End');
  await page.keyboard.type(' lost');
  await page.keyboard.press('Enter');
  for (let press = 0; press < 3; press++) await page.keyboard.press('Tab');
  assert.equal(await editorFocused(), false);
  await page.keyboard.type(' lost');
  await clickCenter(sendBox);
  await settle(page);
  assert.equal(await editorFocused(), false);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  assert.equal(sent().length, 0);
  assert.equal(stops().length, heldStops);

  releaseStop();
  const retryDisconnect = page.locator('.mobile-reconnect-banner').filter({ hasText: 'Agent run could not stop' }).getByRole('button', { name: 'Retry disconnect', exact: true });
  await retryDisconnect.waitFor();
  await settle(page);
  assert.equal(await hostDisabled(), false);
  await clickCenter(editorBox);
  assert.equal(await editorFocused(), true);
  await page.keyboard.press('End');
  await page.keyboard.type(' and send it');
  assert.equal(await editor.inputValue(), 'Keep this draft and send it');
  const received = new Promise(resolve => { host.onRequest = message => { if (message.command === 'pi_command' && message.args.command.type === 'prompt') resolve(message); }; });
  await clickCenter(sendBox);
  assert.equal((await received).args.command.message, 'Keep this draft and send it');
  assert.equal(await retryDisconnect.isEnabled(), true);
  assert.equal(await page.getByLabel('Anchor host address').count(), 0);
  assert.equal(prompts.length, 1);
});
