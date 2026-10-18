import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { build } from 'esbuild';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

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

test('a failed host save keeps the saved address and label, and a later save can recover', async t => {
  await saveMobileAnchor('wss://home.test', 'Home');
  const storage = indexedDB;
  const failure = t.mock.method(storage, 'open', () => { throw new Error('Host storage is unavailable'); });

  await assert.rejects(saveMobileAnchor('wss://office.test', 'Office'), /Host storage is unavailable/);
  assert.equal(cachedMobileHost(), 'wss://home.test/');
  assert.equal(localHostLabel(), 'Home');

  failure.mock.restore();
  assert.deepEqual(await readMobileAnchor(), { name: 'Home', url: 'wss://home.test/' });
  await saveMobileAnchor('wss://office.test', 'Office');
  assert.deepEqual(await readMobileAnchor(), { name: 'Office', url: 'wss://office.test/' });
  assert.equal(cachedMobileHost(), 'wss://office.test/');
  assert.equal(localHostLabel(), 'Office');
});

test('an aborted forget keeps the saved host, and a later forget can recover', async t => {
  await saveMobileAnchor('wss://home.test', 'Home');
  const deleteRecord = IDBObjectStore.prototype.delete;
  const failure = t.mock.method(IDBObjectStore.prototype, 'delete', function (...args) {
    const request = deleteRecord.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort(), { once: true });
    return request;
  });

  await assert.rejects(forgetMobileAnchor());
  assert.equal(cachedMobileHost(), 'wss://home.test/');
  assert.equal(localHostLabel(), 'Home');
  assert.deepEqual(await readMobileAnchor(), { name: 'Home', url: 'wss://home.test/' });

  failure.mock.restore();
  await forgetMobileAnchor();
  assert.equal(await readMobileAnchor(), undefined);
  assert.equal(cachedMobileHost(), '');
});
