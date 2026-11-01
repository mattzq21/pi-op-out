import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFileCommand } from '../native-file-command.mjs';
import { cleanupScope } from '../cleanup-scope.mjs';

const resources = cleanupScope({ after });
let sharedNative;
const invalidURL = { message: 'Enter a valid HTTP or HTTPS URL' };
const unsupportedScheme = { message: 'Only HTTP and HTTPS links can be opened in the browser' };

for (const [description, url, error] of [
  ['an empty URL', '', /Enter a valid HTTP or HTTPS URL/],
  ['relative path', 'relative/path', invalidURL],
  ['missing host', 'https://', invalidURL],
  ['invalid host', 'http://[invalid', invalidURL],
  ['file scheme', 'file:///tmp/file', unsupportedScheme],
  ['script scheme', 'javascript:alert(1)', unsupportedScheme],
  ['data scheme', 'data:text/html,hello', unsupportedScheme],
  ['mail scheme', 'mailto:user@example.com', unsupportedScheme],
  ['FTP scheme', 'ftp://example.com/file', unsupportedScheme],
]) test(`the browser command rejects ${description} without starting the launcher`, async () => {
  const native = await (sharedNative ??= nativeFileCommand(resources, { launcher: {} }));
  const before = await native.launchedTargets();
  await assert.rejects(native.invoke('open_external_url', { url }), error);
  assert.deepEqual(await native.launchedTargets(), before);
});

for (const [description, url, target] of [
  ['normalizes host case, default port and spaces', 'HTTPS://Example.COM:443/a b?x=1&y=2#section', 'https://example.com/a%20b?x=1&y=2#section'],
  ['preserves a nondefault local server port', 'http://localhost:8080/path', 'http://localhost:8080/path'],
  ['preserves encoded query delimiters', 'https://example.com/?q=%26%3D%23', 'https://example.com/?q=%26%3D%23'],
]) test(`the browser command ${description}`, async () => {
  const native = await (sharedNative ??= nativeFileCommand(resources, { launcher: {} }));
  const before = await native.launchedTargets();
  await native.invoke('open_external_url', { url });
  assert.deepEqual((await native.launchedTargets()).slice(before.length), [target]);
});

test('the browser command reports when the system launcher is unavailable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-no-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = await nativeFileCommand(t, { env: { PATH: directory } });
  await assert.rejects(native.invoke('open_external_url', { url: 'https://example.com' }), /Could not open https:\/\/example\.com\/:/);
});

test('the browser command reports a system launcher failure', async t => {
  const native = await nativeFileCommand(t, { launcher: { status: 23 } });
  await assert.rejects(native.invoke('open_external_url', { url: 'https://example.com' }), /xdg-open failed.*23/);
  assert.deepEqual(await native.launchedTargets(), ['https://example.com/']);
});
