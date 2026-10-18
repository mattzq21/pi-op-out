import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startupPage } from '../startup-browser-fixture.mjs';

// 0.3 seconds of silence, synthetic speech until 2.4 seconds, then silence until 4.9 seconds, as 16 kHz mono.
// The browser plays it, in a loop, as the microphone.
const SPEECH = fileURLToPath(new URL('../fixtures/dictation-speech.wav', import.meta.url));
// A snap Chromium cannot read files in hidden folders and plays silence instead, so this test uses the Playwright build.
const BROWSER = chromium.executablePath();

test('dictation ends by itself after the speaker stops, and the recorded audio goes to the speech engine', async t => {
  assert.ok(existsSync(BROWSER), 'Install the Playwright Chromium build for the fake microphone: bunx playwright-core install chromium');
  const engine = [];
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/dictation-recording-browser.tsx', ready: 'main', holdStorage: false, executablePath: BROWSER,
    browserArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + SPEECH, '--autoplay-policy=no-user-gesture-required'],
    prepare: async page => {
      await page.exposeFunction('nativeCommand', async (command, args) => {
        const { clientId, ...request } = args ?? {};
        engine.push({ command, request });
        if (command === 'dictation_stream_start') return { id: 'stream-1' };
        if (command === 'dictation_stream_feed') return null;
        if (command === 'dictation_stream_finish') return { text: 'Please write a note about the weather' };
        throw new Error('Unexpected command: ' + command);
      });
    },
  });
  const started = Date.now();
  await page.getByRole('button', { name: 'Dictate' }).click();
  await page.getByRole('status').filter({ hasText: /^(finished|error)/ }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByRole('status').textContent(), 'finished');
  assert.equal(await page.getByLabel('Dictated text').textContent(), 'Please write a note about the weather');
  // The end needs speech and then 1.5 seconds of silence; it must come before the 120 second limit.
  assert.ok(Date.now() - started > 2000 && Date.now() - started < 15000, 'ended after ' + (Date.now() - started) + ' ms');

  const commands = engine.map(call => call.command);
  assert.equal(commands[0], 'dictation_stream_start');
  assert.equal(commands.at(-1), 'dictation_stream_finish');
  const fed = engine.filter(call => call.command === 'dictation_stream_feed');
  assert.ok(fed.length > 0 && fed.every(call => call.request.id === 'stream-1'));
  const seconds = fed.reduce((total, call) => total + Buffer.from(call.request.audio, 'base64').length / 2, 0) / 16000;
  // Short pauses between words do not end it; 1.5 seconds of silence after the speech does, before the clip starts again.
  assert.ok(seconds > 3.2 && seconds < 4.9, 'sent ' + seconds + ' s of 16 kHz audio');
});
