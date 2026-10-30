import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { launchTestBrowser } from './test-browser.mjs';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['test/fixtures/chat-scroll-place.tsx'], bundle: true, write: false,
  outdir: '/tmp/chat-scroll-place-bundle', conditions: ['browser'], define: { 'import.meta.env.MODE': '"development"' },
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

const browser = await launchTestBrowser();

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
  await page.waitForTimeout(200);
  const place = () => messages.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const turn = [...el.querySelectorAll('[data-response-turn]')].find(item => item.getBoundingClientRect().bottom > top);
    return { id: turn.dataset.responseTurn, offset: Math.round(turn.getBoundingClientRect().top - top) };
  });
  await page.mouse.move(450, 150);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(100); }
  await page.waitForTimeout(300);
  const before = await place();
  await page.evaluate(() => window.setShown(false));
  await page.evaluate(() => { window.appendMessage(); window.appendMessage(); });
  await page.evaluate(() => window.setShown(true));
  await page.waitForTimeout(300);
  assert.deepEqual(await place(), before, 'a chat opens at its old place');
  await messages.evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.setShown(false));
  await page.evaluate(() => window.appendMessage());
  await page.evaluate(() => window.setShown(true));
  await page.waitForTimeout(300);
  assert.ok(await messages.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight <= 2), 'a chat left at the bottom opens at the new bottom');
  assert.deepEqual(errors, []);
  console.log('PASS: chats open at their old scroll place');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
