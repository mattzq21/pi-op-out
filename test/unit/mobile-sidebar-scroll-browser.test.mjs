import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { daemonClient } from '../daemon-client.mjs';

let browser, server, url;
before(async () => {
  const bundle = await build({ entryPoints: ['test/fixtures/mobile-sidebar.tsx'], bundle: true, write: false, format: 'esm', conditions: ['browser'],
    define: { 'import.meta.env.MODE': '"development"', 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'solid', setup(api) {
      api.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({ contents: transformSync(await readFile(path, 'utf8'), {
        filename: path, babelrc: false, configFile: false, presets: [[solid, { generate: 'dom' }], [typescript, { onlyRemoveTypeImports: true }]],
      }).code, loader: 'js' }));
    } }],
  });
  const css = (await readFile('clients/ui/styles.css', 'utf8')) + '\n' + (await readFile('clients/ui/mobile.css', 'utf8'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : req.url === '/app.css' ? css : '<html data-mobile><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"></div><script type="module" src="/app.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? chromium.executablePath(), headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function sidebar(t) {
  let context;
  t.after(async () => context?.close());
  const daemon = await daemonClient(t);
  const sessions = [];
  for (let i = 0; i < 35; i++) {
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    sessions.push({ id: chat.sessionId, name: `Chat ${String(i).padStart(2, '0')}`, path: chat.path, cwd: process.cwd(), project: 'Project', messageCount: 1 });
  }
  await daemon.listChats(sessions);
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.exposeFunction('daemonInvoke', (command, args) => daemon.invoke(command, args));
  await page.addInitScript(sessions => { window.fixtureSessions = sessions; }, sessions);
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto(url);
  await page.getByRole('button', { name: 'Collapse Project', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Chat 06,/ }).waitFor();
  return page;
}

async function swipe(page, target) {
  const box = await target.boundingBox();
  assert.ok(box);
  await target.evaluate(element => {
    let scroll = element.parentElement;
    while (scroll && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
    if (!scroll) throw new Error('Sidebar has no scrollable container');
    window.swipeScroll = scroll;
    window.swipeFinished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { scroll.removeEventListener('scroll', check); reject(new Error('Touch swipe did not scroll the sidebar')); }, 3000);
      function check() { if (scroll.scrollTop > 20) { clearTimeout(timer); scroll.removeEventListener('scroll', check); resolve(); } }
      scroll.addEventListener('scroll', check);
    });
  });
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 6; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 12 }] });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => window.swipeFinished);
  assert.ok(await page.evaluate(() => window.swipeScroll.scrollTop > 20));
}

test('swiping over a chat name scrolls the real sidebar', async t => {
  const page = await sidebar(t);
  await swipe(page, page.getByRole('button', { name: /^Chat 06,/ }));
});

test('swiping over a project name scrolls the real sidebar', async t => {
  const page = await sidebar(t);
  await swipe(page, page.getByRole('button', { name: 'Project', exact: true }));
});
