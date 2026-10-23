import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['test/fixtures/chat-scroll-follow.tsx'], bundle: true, write: false,
  outdir: '/tmp/chat-scroll-bundle', conditions: ['browser'], define: { 'import.meta.env.MODE': '"development"' },
  plugins: [{ name: 'solid', setup(api) {
    api.onResolve({ filter: /\?(raw|url)$/ }, args => ({ path: args.path, namespace: 'asset' }));
    api.onLoad({ filter: /.*/, namespace: 'asset' }, () => ({ contents: 'export default ""', loader: 'js' }));
    api.onLoad({ filter: /\.tsx$/ }, async args => ({ contents: transformSync(await readFile(args.path, 'utf8'), {
      filename: args.path, babelrc: false, configFile: false,
      presets: [[solid, { generate: 'dom' }], [typescript, { onlyRemoveTypeImports: true }]],
    }).code, loader: 'js' }));
  } }],
});

const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;

const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/app.js' ? js : req.url === '/app.css' ? css : '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback: () => {}, invoke: async () => null };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const messages = page.locator('.messages');
  await messages.waitFor();
  const gap = () => messages.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await page.waitForTimeout(200);
  await messages.evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(200);
  assert.ok(await gap() <= 2, 'start at the bottom of existing history');

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.appendMessage());
    await page.waitForTimeout(100);
    assert.ok(await gap() <= 2, 'new prompts must preserve bottom following');
  }

  const input = page.getByRole('textbox', { name: 'Message piop' });
  await input.fill('A long prompt\n'.repeat(20));
  await page.waitForTimeout(100);
  await messages.evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(100);
  await input.press('Enter');
  await page.waitForTimeout(200);
  assert.ok(await gap() <= 2, 'submitting a prompt must preserve bottom following');
  await page.mouse.move(450, 150);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  assert.ok(await gap() > 100, 'wheel scrolling must reveal history');
  const top = await messages.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.appendMessage());
  await page.waitForTimeout(100);
  assert.ok(Math.abs(await messages.evaluate(el => el.scrollTop) - top) <= 2, 'updates must not pull a reader away from history');
  await messages.evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(100);
  await page.evaluate(() => window.appendMessage());
  await page.waitForTimeout(100);
  assert.ok(await gap() <= 2, 'returning to the bottom must resume following');
  await page.evaluate(() => window.appendResponse());
  await page.waitForTimeout(100);
  const actions = await page.locator('.assistant-message .message-actions').last().boundingBox();
  const composer = await page.locator('.composer-stack').boundingBox();
  const clearance = composer.y - (actions.y + actions.height);
  console.log('Response action bar clearance:', clearance);
  assert.ok(clearance >= 22, 'leave space between the response action bar and composer');
  await page.mouse.move(450, 150);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  const afterWheel = await page.locator('.assistant-message .message-actions').last().boundingBox();
  assert.ok(Math.abs(afterWheel.y - actions.y) <= 2, 'scrolling down at the bottom must not reveal more blank space');
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.startResponse());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.finishResponse());
  await page.waitForTimeout(200);
  console.log('Remaining scroll after completion:', await gap());
  assert.ok(await gap() <= 2, 'finishing a response must leave no further downward scroll');
  const completedTop = await messages.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(100);
  assert.ok(Math.abs(await messages.evaluate(el => el.scrollTop) - completedTop) <= 2, 'scrolling after completion must not expose extra space');
  console.log('PASS: deferred history, new prompts, composer resize, and manual scrolling preserve the intended scroll position');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
