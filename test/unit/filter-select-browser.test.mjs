import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { launchTestBrowser } from '../test-browser.mjs';

let server, browser, url;
before(async () => {
  const bundle = await build({
    entryPoints: ['test/fixtures/filter-select-browser.tsx'], bundle: true, write: false, conditions: ['browser'],
    plugins: [{ name: 'solid', setup(api) {
      api.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({ contents: transformSync(await readFile(path, 'utf8'), {
        filename: path, babelrc: false, configFile: false,
        presets: [[solid, { generate: 'dom' }], [typescript, { onlyRemoveTypeImports: true }]],
      }).code, loader: 'js' }));
    } }],
  });
  const css = await readFile('clients/ui/styles.css', 'utf8');
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : req.url === '/app.css' ? css : '<link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await launchTestBrowser();
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

test('filtering shows the first match at the top of the list', async t => {
  const context = await browser.newContext({ viewport: { width: 600, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto(url);
  await page.getByRole('button', { name: 'Model' }).click();
  const list = page.getByRole('listbox', { name: 'Model options' });
  assert.ok(await list.evaluate(node => node.scrollTop > 0), 'the selected model near the end is scrolled into view');
  await page.getByRole('textbox', { name: 'Filter Model' }).pressSequentially('sol');
  assert.equal(await list.evaluate(node => node.scrollTop), 0);
  assert.equal(await page.locator('.filter-select-menu [data-active]').textContent(), 'Solace: Sol 0');
});
