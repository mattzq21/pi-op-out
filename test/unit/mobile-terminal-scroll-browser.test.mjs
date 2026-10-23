import { test, after } from 'node:test';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const bundle = await build({entryPoints:['test/fixtures/mobile-terminal-scroll.tsx'], bundle:true, write:false,
  outdir:'/tmp/terminal-cursor-bundle', conditions:['browser'], define:{'import.meta.env.MODE':'"development"'},
  plugins:[{name:'solid',setup(api){
    api.onLoad({filter:/\.tsx$/},async args=>({contents:transformSync(await readFile(args.path,'utf8'),{filename:args.path,babelrc:false,configFile:false,presets:[[solid,{generate:'dom'}],[typescript,{onlyRemoveTypeImports:true}]]}).code,loader:'js'}));
  }}]});

const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;

const css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;

const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':req.url==='/app.css'?'text/css':'text/html');res.end(req.url==='/app.js'?js:req.url==='/app.css'?css:'<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');});

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

const browser=await chromium.launch({executablePath:process.env.CHROME_BIN ?? chromium.executablePath(),headless:true});

after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });

async function openTerminal(t) {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  t.after(() => page.close());
  await page.getByRole('textbox', { name: 'Terminal command' }).waitFor();
  return page;
}

test('history scrolls without taking ownership and a tap claims the terminal', async t => {
  const page = await openTerminal(t);
  const transcript=page.locator('.terminal-transcript');
  await transcript.waitFor();
  const cdp=await page.context().newCDPSession(page);
  const state=()=>transcript.evaluate(el=>({top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight,history:el.textContent.includes('history 0')}));

  for (const unowned of [false,true]) {
    await page.evaluate(unowned=>window.setUnowned(unowned),unowned);
    await transcript.evaluate(el=>el.scrollTop=el.scrollHeight);
    await page.waitForTimeout(100);
    const before=await state();
    const box=await transcript.boundingBox();
    const x=box.x+box.width/2,y=box.y+30;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});

    for(let i=1;i<=8;i++) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+i*12}]});
      await page.waitForTimeout(20);
    }

    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForTimeout(200);
    const after=await state();
    console.log(JSON.stringify({unowned,before,after,claims:await page.evaluate(()=>window.claims)}));
    assert.ok(after.history,'history must remain in the transcript');
    assert.ok(after.top<before.top-30,'swiping down must reveal earlier terminal output');
    assert.equal(await page.evaluate(()=>window.claims),0,'scrolling must not take ownership');
    await page.evaluate(()=>window.feed('\r\nnew output\r\n'));
    await page.waitForTimeout(100);
    assert.ok(Math.abs((await state()).top-after.top)<3,'incoming output must preserve the history scroll position');
  }

  await transcript.tap({position:{x:25,y:25}});
  await page.waitForFunction(()=>window.claims===1);
  await page.evaluate(() => new Promise(resolve => {
    const input = document.querySelector('[aria-label="Terminal command"]');
    if (document.activeElement === input) { resolve(); return; }
    input.addEventListener('focus', () => resolve(), { once: true });
  }));
  assert.equal(await page.locator('[aria-label="Terminal command"]').evaluate(el=>document.activeElement===el),true,'a tap must take ownership and focus input');
  console.log('PASS: history scrolls with or without ownership; tapping still claims and focuses input');
 });

test('long mobile commands wrap onto visible lines', async t => {
  const page = await openTerminal(t);
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  await command.fill('abcdefghij '.repeat(12));
  const layout = await command.evaluate(el => ({ height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) }));
  assert.ok(layout.height > layout.lineHeight * 2, 'long commands must wrap onto visible lines');
  assert.ok(await command.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'the beginning must remain visible');
});

test('typing at the end of a mobile command publishes the complete draft', async t => {
  const page = await openTerminal(t);
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  await command.fill('echo start');
  await command.press('End');
  await page.keyboard.insertText(' suffix');
  assert.equal(await command.textContent(), 'echo start suffix');
  assert.equal(await page.evaluate(() => window.lastDraft), 'echo start suffix');
});

test('Enter sends the mobile command and clears the input', async t => {
  const page = await openTerminal(t);
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  await command.fill('echo hello');
  await command.press('Enter');
  assert.equal(await command.textContent(), '');
  assert.equal(await page.evaluate(() => window.lastData), 'echo hello\r');
});

test('unbroken mobile commands wrap without horizontal scrolling', async t => {
  const page = await openTerminal(t);
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  await command.fill('x'.repeat(500));
  const layout = await command.evaluate(el => ({ height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight), width: el.clientWidth, scrollWidth: el.scrollWidth }));
  assert.ok(layout.height > layout.lineHeight * 2);
  assert.ok(layout.scrollWidth <= layout.width + 1);
});

test('Control+C sends an interrupt and clears the mobile command', async t => {
  const page = await openTerminal(t);
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  await command.fill('unfinished command');
  await command.press('End');
  await command.press('Control+c');
  assert.equal(await command.textContent(), '');
  assert.equal(await page.evaluate(() => window.lastData), '\u0003');
});
