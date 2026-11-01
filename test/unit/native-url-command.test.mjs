import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';
import { cleanupScope } from '../cleanup-scope.mjs';

const resources = cleanupScope({ after });
let rejectionNative;
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
  const native = await (rejectionNative ??= nativeFileCommand(resources, { launcher: {} }));
  const before = await native.launchedTargets();
  await assert.rejects(native.invoke('open_external_url', { url }), error);
  assert.deepEqual(await native.launchedTargets(), before);
});

test('the browser command normalizes host case, default port and spaces', async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await native.invoke('open_external_url', { url: 'HTTPS://Example.COM:443/a b?x=1&y=2#section' });
  assert.deepEqual(await native.launchedTargets(), ['https://example.com/a%20b?x=1&y=2#section']);
});

test('the browser command preserves a nondefault local server port', async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await native.invoke('open_external_url', { url: 'http://localhost:8080/path' });
  assert.deepEqual(await native.launchedTargets(), ['http://localhost:8080/path']);
});

test('the browser command preserves encoded query delimiters', async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await native.invoke('open_external_url', { url: 'https://example.com/?q=%26%3D%23' });
  assert.deepEqual(await native.launchedTargets(), ['https://example.com/?q=%26%3D%23']);
});

test('the browser command reports a system launcher failure', async t => {
  const native = await nativeFileCommand(t, { launcher: { status: 23 } });
  await assert.rejects(native.invoke('open_external_url', { url: 'https://example.com' }), /xdg-open failed.*23/);
  assert.deepEqual(await native.launchedTargets(), ['https://example.com/']);
});
