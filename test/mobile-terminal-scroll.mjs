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

const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true});

try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
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
  assert.equal(await page.locator('[aria-label="Terminal command"]').evaluate(el=>document.activeElement===el),true,'a tap must take ownership and focus input');
  console.log('PASS: history scrolls with or without ownership; tapping still claims and focuses input');
  const command=page.getByRole('textbox',{name:'Terminal command'});
  await command.fill('abcdefghij '.repeat(12));
  const layout=await command.evaluate(el=>({height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight)}));
  assert.ok(layout.height>layout.lineHeight*2,'long mobile commands must wrap onto visible lines');
  assert.ok(await transcript.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'command must not hide its beginning in horizontal scrolling');
  await command.press('End');
  await page.keyboard.insertText('suffix');
  assert.equal(await page.evaluate(()=>window.lastDraft),'abcdefghij '.repeat(12)+'suffix','typing must preserve the caret and publish the whole draft');
  await command.press('Enter');
  assert.equal(await page.evaluate(()=>window.lastData),'abcdefghij '.repeat(12)+'suffix\r');
  assert.equal(await command.textContent(),'');
  await command.fill('x'.repeat(500));
  assert.ok(await transcript.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'unbroken commands must also wrap');
  await command.press('End');
  await command.press('Control+c');
  assert.equal(await page.evaluate(()=>window.lastData),'\u0003');
  assert.equal(await command.textContent(),'');
  console.log('PASS: commands wrap, drafts update, Enter submits and Ctrl+C interrupts');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
