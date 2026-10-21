import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startupPage } from '../startup-browser-fixture.mjs';

const SPEECH = fileURLToPath(new URL('../fixtures/dictation-speech.wav', import.meta.url));
// A snap Chromium cannot read files in hidden folders and plays silence instead, so this test uses the Playwright build.
const BROWSER = chromium.executablePath();
const native = command => 'plugin:dictation|' + command;

/** The composer with its plugin tools, and a native side that records each command. finish(id) gives the text of a stream. */
async function dictationPage(t, statuses, finish) {
  assert.ok(existsSync(BROWSER), 'Install the Playwright Chromium build for the fake microphone: bunx playwright-core install chromium');
  const engine = [];
  let streams = 0;
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/dictation-plugin-browser.tsx', ready: 'main', holdStorage: false, executablePath: BROWSER,
    browserArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + SPEECH, '--autoplay-policy=no-user-gesture-required'],
    prepare: async page => {
      await page.exposeFunction('nativeCommand', async (command, args) => {
        const { clientId, ...request } = args ?? {};
        engine.push({ command, request });
        if (command === 'plugin_status') return statuses[request.hostId];
        if (command === native('dictation_configuration')) return { enabled: true, loading: false, engine: 'transcribe.cpp' };
        if (command === native('dictation_stream_start')) return { id: 'stream-' + ++streams };
        if (command === native('dictation_stream_feed') || command === native('dictation_stream_cancel')) return null;
        if (command === native('dictation_stream_finish')) return { text: finish(request.id) };
        throw new Error('Unexpected command: ' + command);
      });
    },
  });
  const sent = command => engine.filter(call => call.command === native(command));
  const until = async check => { for (const end = Date.now() + 10000; !check(); await page.waitForTimeout(50)) if (Date.now() > end) throw new Error('Timed out; got ' + engine.map(call => call.command).join(', ')); };
  /** Changes the plugin setup of a host, as a daemon restart does, and waits until the workspace has applied it. */
  const setPlugins = async (hostId, next) => {
    const before = engine.length;
    statuses[hostId] = next;
    await page.evaluate(hostId => window.nativeEvent('pi://plugins-changed', { hostId }), hostId);
    await until(() => engine.slice(before).some(call => call.command === 'plugin_status' && call.request.hostId === hostId));
    await page.evaluate(hostId => window.pluginsSettled(hostId), hostId);
  };
  return {
    page, engine, sent, until, setPlugins,
    dictate: page.getByRole('button', { name: 'Dictate', exact: true }),
    stop: page.getByRole('button', { name: 'Stop dictation', exact: true }),
    draft: page.getByLabel('Draft'),
  };
}

test('the Dictation plugin adds its controls to the composer only while it is enabled, and disabling it cancels a recording without changing the draft', async t => {
  const { page, engine, sent, until, setPlugins, dictate, stop, draft } = await dictationPage(t, {
    local: { enabled: [], configured: [], revision: 'off-1', error: null },
  }, () => 'Write a note about rain');

  // Disabled: no controls, no engine status read, and an engine status event does not bring the controls.
  await until(() => engine.some(call => call.command === 'plugin_status'));
  await page.evaluate(() => window.pluginsSettled('local'));
  await page.evaluate(() => window.nativeEvent('pi://dictation', { enabled: true, loading: false }));
  await page.waitForTimeout(500);
  assert.equal(await dictate.count(), 0);
  assert.deepEqual(engine.filter(call => call.command.startsWith('plugin:dictation|')), []);

  // Enabled: the controls read the engine status and show.
  await setPlugins('local', { enabled: ['dictation'], configured: ['dictation'], revision: 'on-1', error: null });
  await dictate.waitFor();
  assert.ok(sent('dictation_configuration').length > 0);

  // Disabled while recording: the engine stream is cancelled, nothing is transcribed, and the draft stays as it was.
  await dictate.click();
  await stop.waitFor();
  await until(() => sent('dictation_stream_feed').length > 0);
  await setPlugins('local', { enabled: [], configured: [], revision: 'off-2', error: null });
  await stop.waitFor({ state: 'detached' });
  await until(() => sent('dictation_stream_cancel').length === 1);
  assert.deepEqual(sent('dictation_stream_cancel')[0].request, { id: 'stream-1' });
  assert.equal(sent('dictation_stream_finish').length, 0);
  assert.equal(await dictate.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel dictation' }).count(), 0);
  assert.equal(await draft.textContent(), 'Unsent words');
  const fed = sent('dictation_stream_feed').length;
  await page.waitForTimeout(500);
  assert.equal(sent('dictation_stream_feed').length, fed, 'no audio goes to the engine after the plugin is disabled');

  // Enabled again: a new dictation works and its text goes into the draft.
  await setPlugins('local', { enabled: ['dictation'], configured: ['dictation'], revision: 'on-2', error: null });
  await dictate.click();
  await stop.waitFor();
  await until(() => sent('dictation_stream_feed').some(call => call.request.id === 'stream-2'));
  await stop.click();
  await dictate.waitFor();
  assert.equal(await draft.textContent(), 'Unsent words Write a note about rain');
  assert.deepEqual(sent('dictation_stream_finish').map(call => call.request), [{ id: 'stream-2' }]);
  assert.equal(sent('dictation_stream_cancel').length, 1);
});

test('a daemon restart that keeps Dictation enabled does not stop a recording, also in a chat on a remote host', async t => {
  const statuses = {
    local: { enabled: ['dictation'], configured: ['dictation'], revision: 'local-1', error: null },
    remote: { enabled: ['cost'], configured: ['cost'], revision: 'remote-1', error: null },
  };
  const { page, engine, sent, until, setPlugins, dictate, stop, draft } = await dictationPage(t, statuses, () => 'Write a note about rain');

  // Dictation is a plugin of this device, so a chat on a remote host shows it too.
  await page.evaluate(() => window.chooseHost('remote'));
  await until(() => engine.some(call => call.command === 'plugin_status' && call.request.hostId === 'remote'));
  await dictate.waitFor();
  await dictate.click();
  await stop.waitFor();
  await until(() => sent('dictation_stream_feed').length > 0);

  // Both daemons restart with the same plugins: the recording goes on and audio still reaches the engine.
  await setPlugins('local', { ...statuses.local, revision: 'local-2' });
  await setPlugins('remote', { ...statuses.remote, revision: 'remote-2' });
  const fed = sent('dictation_stream_feed').length;
  await until(() => sent('dictation_stream_feed').length > fed);
  assert.equal(await stop.count(), 1);
  assert.equal(sent('dictation_stream_cancel').length, 0);
  assert.equal(sent('dictation_stream_start').length, 1);

  await stop.click();
  await dictate.waitFor();
  assert.equal(await draft.textContent(), 'Unsent words Write a note about rain');
  assert.deepEqual(sent('dictation_stream_finish').map(call => call.request), [{ id: 'stream-1' }]);
  assert.equal(sent('dictation_stream_cancel').length, 0);
});
