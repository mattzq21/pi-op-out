import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/mobileHosts.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });

const { readMobileHosts, saveMobileHost, removeMobileHost } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

let stored, previousStorage;

beforeEach(() => {
  stored = new Map(); previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  } });
});

afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete globalThis.localStorage;
});

test('saved hosts tolerate corrupt storage and reject unsafe or malformed entries', () => {
  assert.deepEqual(readMobileHosts(), []);

  for (const value of ['{', '{}', 'null']) {
    stored.set('piop-mobile-hosts', value); assert.deepEqual(readMobileHosts(), []);
  }

  stored.set('piop-mobile-hosts', JSON.stringify([
    null, { name: 1, url: 'wss://valid.test' }, { name: 'Missing' },
    { name: 'Unsafe', url: 'ws://unsafe.test' }, { name: 'Secret', url: 'wss://user:pass@host.test' },
    { name: 'Query', url: 'wss://host.test/?secret=x' }, { name: 'Work', url: 'wss://WORK.test' },
  ]));
  assert.deepEqual(readMobileHosts(), [{ name: 'Work', url: 'wss://work.test/' }]);
});

test('saving normalizes addresses, deduplicates hosts and preserves names unless renamed', () => {
  assert.deepEqual(saveMobileHost(' wss://WORK.test ', ' Office '), [{ name: 'Office', url: 'wss://work.test/' }]);
  saveMobileHost('wss://home.test', '');
  assert.deepEqual(saveMobileHost('wss://work.test/', ''), [
    { name: 'home.test', url: 'wss://home.test/' }, { name: 'Office', url: 'wss://work.test/' },
  ]);
  assert.equal(saveMobileHost('wss://work.test', 'Renamed').at(-1).name, 'Renamed');
  const before = stored.get('piop-mobile-hosts');
  assert.throws(() => saveMobileHost('https://invalid.test', 'No'), /secure wss/);
  assert.equal(stored.get('piop-mobile-hosts'), before);
});

test('removing a host preserves other hosts and clears only its matching reconnect address', () => {
  saveMobileHost('wss://work.test', 'Work'); saveMobileHost('wss://home.test', 'Home');
  stored.set('piop-mobile-host', 'wss://home.test');
  assert.deepEqual(removeMobileHost('wss://work.test/'), [{ name: 'Home', url: 'wss://home.test/' }]);
  assert.equal(stored.get('piop-mobile-host'), 'wss://home.test');
  assert.deepEqual(removeMobileHost('wss://home.test/'), []);
  assert.equal(stored.has('piop-mobile-host'), false);
  assert.deepEqual(readMobileHosts(), []);
});
