import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

async function script(path) {
  try { return (await promisify(execFile)(process.execPath, [path], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch (error) { assert.fail(`${path} failed:\n${error.stdout ?? ''}${error.stderr ?? error.message}`); }
}

test('the chat keeps following new output at the bottom, and keeps a reader in history where they scrolled', async () => {
  assert.match(await script('test/chat-scroll-follow.mjs'), /^PASS: /m);
});

test('a chat opens at the scroll place it had, also after new messages', async () => {
  assert.match(await script('test/chat-scroll-place.mjs'), /^PASS: /m);
});

test('the desktop terminal and its shell agree on the width, so the cursor returns to the prompt', async () => {
  assert.equal((await script('test/terminal-cursor.mjs')).match(/^PASS /gm)?.length, 3);
});
