import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { chromium } from 'playwright-core';

export async function startupPage(t, mode, { entryPoint = 'test/fixtures/startup.tsx', ready = '[role="status"]', holdStorage = true, prepare = async () => {} } = {}) {
  const bundle = await build({ entryPoints: [entryPoint], outdir: '/tmp/piop-startup-browser', entryNames: 'startup', bundle: true, write: false, format: 'esm', conditions: ['browser'], logLevel: 'silent',
    define: { 'import.meta.env.MODE': JSON.stringify(mode), 'import.meta.env.DEV': String(mode === 'development'), 'import.meta.env.TAURI_ENV_DEBUG': '"false"', 'import.meta.env.VITE_PIOP_DEBUG': '"false"', 'import.meta.hot': 'globalThis.startupHot' },
    plugins: [{ name: 'browser-source', setup(api) {
      api.onResolve({ filter: /\?url$/ }, async args => ({ path: (await api.resolve(args.path.replace(/\?url$/, ''), { resolveDir: args.resolveDir, kind: args.kind })).path, namespace: 'asset' }));
      api.onLoad({ filter: /.*/, namespace: 'asset' }, async ({ path }) => ({ contents: await readFile(path), loader: 'file' }));
      api.onResolve({ filter: /\?raw$/ }, args => ({ path: new URL(args.path.replace(/\?raw$/, ''), 'file://' + args.resolveDir + '/').pathname, namespace: 'raw' }));
      api.onLoad({ filter: /.*/, namespace: 'raw' }, async ({ path }) => ({ contents: await readFile(path, 'utf8'), loader: 'text' }));
      api.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({ contents: transformSync(await readFile(path, 'utf8'), { filename: path, babelrc: false, configFile: false, presets: [[solid, { generate: 'dom' }], [typescript, { onlyRemoveTypeImports: true }]] }).code, loader: 'js' }));
    } }],
  });
  const files = new Map(bundle.outputFiles.map(file => ['/' + basename(file.path), file.contents]));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url?.endsWith('.js') ? 'text/javascript' : req.url?.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(files.get(req.url) ?? '<html><link rel="stylesheet" href="/startup.css"><div id="root"></div><aside id="sample"></aside><script type="module" src="/startup.js"></script></html>');
  });
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(({ mode, holdStorage }) => {
    if (holdStorage) Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: () => ({}) } });
    window.startupHot = mode === 'development' ? { on() {}, off() {}, dispose(callback) { window.disposeStartup = callback; } } : undefined;
  }, { mode, holdStorage });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await prepare(page);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(ready).waitFor();
  return page;
}
