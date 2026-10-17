import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';

const compiled = await build({ entryPoints: ['clients/ui/lib/mobileHosts.ts'], bundle: true, write: false, format: 'esm', platform: 'node', define: { 'import.meta.env.MODE': '"mobile"' } });

const { readMobileAnchor, saveMobileAnchor, forgetMobileAnchor, validateMobileAnchor, cachedMobileHost, localHostLabel, useDevelopmentAnchor } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

let previousStorage;
beforeEach(async () => {
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  await readMobileAnchor();
});
afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'indexedDB', previousStorage);
  else delete globalThis.indexedDB;
});

test('anchor validation rejects unsafe addresses and missing names', async () => {
  assert.equal(await readMobileAnchor(), undefined);
  for (const address of ['ws://unsafe.test', 'wss://user:pass@host.test', 'wss://host.test/?secret=x', 'wss://host.test/#secret', 'invalid']) {
    assert.throws(() => validateMobileAnchor(address, 'Work'));
  }
  assert.throws(() => validateMobileAnchor('wss://work.test', '  '), /host name/);
  assert.deepEqual(validateMobileAnchor(' wss://WORK.test ', ' Work '), { name: 'Work', url: 'wss://work.test/' });
});

test('saving normalizes the anchor and replaces the previous machine', async () => {
  await saveMobileAnchor(' wss://WORK.test ', ' Office ');
  assert.deepEqual(await readMobileAnchor(), { name: 'Office', url: 'wss://work.test/' });
  await saveMobileAnchor('wss://home.test', 'Home');
  assert.deepEqual(await readMobileAnchor(), { name: 'Home', url: 'wss://home.test/' });
  assert.equal(cachedMobileHost(), 'wss://home.test/');
  assert.throws(() => saveMobileAnchor('https://invalid.test', 'No'), /secure wss/);
  assert.deepEqual(await readMobileAnchor(), { name: 'Home', url: 'wss://home.test/' });
});

test('forgetting the anchor clears saved and cached connection details', async () => {
  await saveMobileAnchor('wss://home.test', 'Home');
  await forgetMobileAnchor();
  assert.equal(await readMobileAnchor(), undefined);
  assert.equal(cachedMobileHost(), '');
  await forgetMobileAnchor();
  assert.equal(await readMobileAnchor(), undefined);
});

test('a development connection is used for this run without replacing the saved anchor', async () => {
  await saveMobileAnchor('wss://home.test', 'Home');
  assert.equal(localHostLabel(), 'Home');
  useDevelopmentAnchor('ws://10.0.2.2:4100');
  assert.equal(cachedMobileHost(), 'ws://10.0.2.2:4100');
  assert.equal(localHostLabel(), 'Development');
  assert.deepEqual(await readMobileAnchor(), { name: 'Home', url: 'wss://home.test/' });
});
