import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('shared browser keeps test storage separate and closes each completed context', async t => {
  const cleanup = [];
  const fixture = { after: callback => cleanup.push(callback) };
  const options = { entryPoint: 'test/fixtures/chat-scroll-browser.tsx', ready: '.messages', holdStorage: false };
  let first;
  try {
    first = await startupPage(fixture, 'production', options);
    await first.context().addCookies([{ name: 'previous-test', value: 'private', url: first.url() }]);
    await first.evaluate(() => localStorage.setItem('previous-test', 'private'));
    const second = await startupPage(t, 'production', options);
    assert.equal(first.context().browser(), second.context().browser());
    assert.notEqual(first.context(), second.context());
    assert.deepEqual(await second.context().cookies(), []);
    assert.equal(await second.evaluate(() => localStorage.getItem('previous-test')), null);
    for (const close of cleanup.splice(0)) await close();
    assert.equal(first.isClosed(), true);
    assert.equal(second.isClosed(), false);
    assert.equal(second.context().browser().contexts().length, 1);
    assert.equal(await second.locator('.messages').count(), 1);
  } finally {
    for (const close of cleanup) await close();
  }
});
