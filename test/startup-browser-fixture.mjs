import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { chromium } from 'playwright-core';

const bundles = new Map();

function browserFiles(entryPoint, mode) {
  const key = JSON.stringify([resolve(entryPoint), mode]);
  if (!bundles.has(key)) {
    const pending = buildBrowserFiles(entryPoint, mode).catch(error => {
      bundles.delete(key);
      throw error;
    });
    bundles.set(key, pending);
  }
  return bundles.get(key);
}

async function buildBrowserFiles(entryPoint, mode) {
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
  return new Map(bundle.outputFiles.map(file => ['/' + basename(file.path), file.contents]));
}

export async function startupPage(t, mode, { entryPoint = 'test/fixtures/startup.tsx', ready = '[role="status"]', holdStorage = true, prepare = async () => {}, browserArgs = [], executablePath } = {}) {
  const files = await browserFiles(entryPoint, mode);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', /\.m?js$/.test(req.url ?? '') ? 'text/javascript' : req.url?.endsWith('.css') ? 'text/css' : req.url?.endsWith('.wasm') ? 'application/wasm' : 'text/html');
    res.end(files.get(req.url) ?? '<html><link rel="stylesheet" href="/startup.css"><div id="root"></div><aside id="sample"></aside><script type="module" src="/startup.js"></script></html>');
  });
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: executablePath ?? process.env.CHROME_BIN ?? execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: browserArgs });
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
