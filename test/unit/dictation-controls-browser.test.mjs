import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startupPage } from '../startup-browser-fixture.mjs';

// Speech from 0.3 to 2.4 seconds, played in a loop as the microphone.
const SPEECH = fileURLToPath(new URL('../fixtures/dictation-speech.wav', import.meta.url));
// A snap Chromium cannot read files in hidden folders, so this test uses the Playwright build.
const BROWSER = chromium.executablePath();

/** A page with the dictation buttons and a draft, whose speech engine answers with finalText. */
async function dictationPage(t, { finalText = 'Write a note', configuration = { enabled: true, loading: false } } = {}) {
  assert.ok(existsSync(BROWSER), 'Install the Playwright Chromium build for the fake microphone: bunx playwright-core install chromium');
  const engine = [];
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/dictation-controls-browser.tsx', ready: 'main', holdStorage: false, executablePath: BROWSER,
    browserArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + SPEECH, '--autoplay-policy=no-user-gesture-required'],
    prepare: async page => {
      await page.exposeFunction('nativeCommand', async (command, args) => {
        const { clientId, ...request } = args ?? {};
        engine.push({ command, request });
        if (command === 'dictation_configuration') return configuration;
        if (command === 'dictation_stream_start') return { id: 'stream-1' };
        if (command === 'dictation_stream_feed' || command === 'dictation_stream_cancel') return null;
        if (command === 'dictation_stream_finish') return { text: finalText };
        throw new Error('Unexpected command: ' + command);
      });
    },
  });
  const sent = command => engine.filter(call => call.command === command);
  const until = async check => { for (const end = Date.now() + 10000; !check(); await page.waitForTimeout(50)) if (Date.now() > end) throw new Error('Timed out; engine got ' + engine.map(call => call.command).join(', ')); };
  return { page, sent, until };
}

test('the user sees the words while speaking, and stopping puts the final text in the draft', async t => {
  const { page, sent, until } = await dictationPage(t, { finalText: '  Write a note about rain  ' });
  await page.getByRole('button', { name: 'Dictate' }).click();
  await page.getByRole('button', { name: 'Stop dictation' }).waitFor();
  await until(() => sent('dictation_stream_feed').length > 0);
  await page.evaluate(() => window.nativeEvent('pi://dictation-stream', { id: 'stream-1', committed: 'Write a note', tentative: 'about' }));
  await page.locator('.dictation-live').filter({ hasText: 'Write a note about' }).waitFor();
  await page.getByRole('button', { name: 'Stop dictation' }).click();
  await page.getByRole('button', { name: 'Dictate' }).waitFor();
  assert.equal(await page.getByLabel('Draft').textContent(), 'Write a note about rain');
  assert.equal(await page.locator('.dictation-live').count(), 0);
  assert.equal(sent('dictation_stream_finish').length, 1);
});

test('cancelling a dictation keeps the draft as it was and ends the speech engine stream', async t => {
  const { page, sent, until } = await dictationPage(t);
  await page.getByRole('button', { name: 'Dictate' }).click();
  await page.getByRole('button', { name: 'Stop dictation' }).waitFor();
  await until(() => sent('dictation_stream_feed').length > 0);
  await page.getByRole('button', { name: 'Cancel dictation' }).click();
  await page.getByRole('button', { name: 'Dictate' }).waitFor();
  await until(() => sent('dictation_stream_cancel').length === 1);
  assert.equal(await page.getByLabel('Draft').textContent(), '');
  assert.equal(sent('dictation_stream_finish').length, 0);
});

test('a speech engine failure while speaking ends the dictation and shows the error', async t => {
  const { page, sent, until } = await dictationPage(t);
  await page.getByRole('button', { name: 'Dictate' }).click();
  await page.getByRole('button', { name: 'Stop dictation' }).waitFor();
  await until(() => sent('dictation_stream_feed').length > 0);
  await page.evaluate(() => window.nativeEvent('pi://dictation-stream', { id: 'stream-1', error: 'The speech model crashed' }));
  await page.getByRole('alert').filter({ hasText: 'The speech model crashed' }).waitFor();
  await page.getByRole('button', { name: 'Dictate' }).waitFor();
  assert.equal(await page.getByLabel('Draft').textContent(), '');
  assert.equal(sent('dictation_stream_finish').length, 0);
});

test('a speech engine that is not set up hides the button and says what is wrong', async t => {
  const { page } = await dictationPage(t, { configuration: { enabled: false, loading: false, error: 'Choose a speech model in Settings' } });
  await page.getByRole('alert').filter({ hasText: 'Choose a speech model in Settings' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Dictate' }).count(), 0);
});
