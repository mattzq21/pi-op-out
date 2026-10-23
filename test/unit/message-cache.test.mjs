import { installDom, renderComponent } from '../dom.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Message } from '../../clients/ui/components/Message.tsx';
import { debugView } from '../../clients/ui/lib/debugFeatures.ts';

const allDebug = debugView({ debugMode: true });

async function renderCache(t, usage, extra = {}) {
  const dom = installDom();
  let view;
  t.after(async () => { await view?.unmount(); dom.restore(); });
  const style = document.createElement('style');
  style.textContent = await readFile(new URL('../../clients/ui/styles.css', import.meta.url), 'utf8');
  document.head.append(style);
  view = await renderComponent(Message, { message: { id: 'response', role: 'assistant', content: 'Answer', usage }, debug: allDebug, ...extra });
  return document.querySelector('[aria-label^="Cache "]');
}

test('a response without usage does not show cache statistics', async t => {
  assert.equal(await renderCache(t), null);
  assert.match(document.body.textContent, /Answer/);
});

test('zero token usage does not show a cache percentage', async t => {
  assert.equal(await renderCache(t, { input: 0, cacheRead: 0 }), null);
  assert.match(document.body.textContent, /Answer/);
});

test('half the prompt cached at one thousand tokens is not marked as low', async t => {
  const cache = await renderCache(t, { input: 1000, cacheRead: 1000 });
  assert.equal(cache.getAttribute('aria-label'), 'Cache 50%, 1000/2000');
  assert.notEqual(getComputedStyle(cache).color, 'rgb(215, 120, 101)');
});

test('fewer than one thousand cached tokens shows a warning even at one hundred percent', async t => {
  const cache = await renderCache(t, { input: 0, cacheRead: 999 });
  assert.equal(cache.getAttribute('aria-label'), 'Cache 100%, 999/999');
  assert.equal(getComputedStyle(cache).color, 'rgb(215, 120, 101)');
});

test('cache writes count toward prompt size and can lower the hit rate below the warning threshold', async t => {
  const cache = await renderCache(t, { input: 1000, cacheRead: 1000, cacheWrite: 1000 });
  assert.equal(cache.getAttribute('aria-label'), 'Cache 33%, 1000/3000');
  assert.equal(getComputedStyle(cache).color, 'rgb(215, 120, 101)');
});

test('the response displays cache totals for the full turn when supplied', async t => {
  const cache = await renderCache(t, { input: 1000, cacheRead: 1000 }, { turnCacheUsage: { input: 1000, cacheRead: 3000 } });
  assert.equal(cache.getAttribute('aria-label'), 'Cache 75%, 3000/4000');
  assert.match(cache.textContent, /^75%/);
});
