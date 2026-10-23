import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFileCommand } from '../native-file-command.mjs';

test('the browser command rejects an empty URL without starting the launcher', async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: '' }), /Enter a valid HTTP or HTTPS URL/);
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects relative path without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "relative/path" }), { message: "Enter a valid HTTP or HTTPS URL" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects missing host without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "https://" }), { message: "Enter a valid HTTP or HTTPS URL" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects invalid host without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "http://[invalid" }), { message: "Enter a valid HTTP or HTTPS URL" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects file scheme without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "file:///tmp/file" }), { message: "Only HTTP and HTTPS links can be opened in the browser" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects script scheme without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "javascript:alert(1)" }), { message: "Only HTTP and HTTPS links can be opened in the browser" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects data scheme without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "data:text/html,hello" }), { message: "Only HTTP and HTTPS links can be opened in the browser" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects mail scheme without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "mailto:user@example.com" }), { message: "Only HTTP and HTTPS links can be opened in the browser" });
  assert.deepEqual(await native.launchedTargets(), []);
});

test("the browser command rejects FTP scheme without starting the launcher", async t => {
  const native = await nativeFileCommand(t, { launcher: {} });
  await assert.rejects(native.invoke('open_external_url', { url: "ftp://example.com/file" }), { message: "Only HTTP and HTTPS links can be opened in the browser" });
  assert.deepEqual(await native.launchedTargets(), []);
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
