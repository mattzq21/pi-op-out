import { build } from 'esbuild';
import { transformSync } from '@babel/core';
import solid from 'babel-preset-solid';
import typescript from '@babel/preset-typescript';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';

const bundle = await build({entryPoints:['test/fixtures/desktop-terminal-cursor.tsx'], bundle:true, write:false,
  outdir:'/tmp/terminal-cursor-bundle', conditions:['browser'], define:{'import.meta.env.MODE':'"development"'},
  plugins:[{name:'solid',setup(api){
    api.onResolve({filter:/^@xterm\/xterm$/},()=>({path:'terminal-proxy',namespace:'repro'}));
    api.onLoad({filter:/.*/,namespace:'repro'},()=>({contents:`import { Terminal as Real } from ${JSON.stringify(path.resolve('node_modules/@xterm/xterm/lib/xterm.js'))}; export class Terminal extends Real { constructor(options) { super(options); window.realTerminal = this; } }`,resolveDir:process.cwd()}));
    api.onLoad({filter:/\.tsx$/},async args=>({contents:transformSync(await readFile(args.path,'utf8'),{filename:args.path,babelrc:false,configFile:false,presets:[[solid,{generate:'dom'}],[typescript,{onlyRemoveTypeImports:true}]]}).code,loader:'js'}));
  }}]});

const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;

const css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;

const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':req.url==='/app.css'?'text/css':'text/html');res.end(req.url==='/app.js'?js:req.url==='/app.css'?css:'<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');});

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true});

const python=String.raw`
import os, pty, fcntl, termios, struct, select, json, sys, signal
size=json.loads(sys.argv[1])
pid,fd=pty.fork()
if pid==0:
    fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',size['rows'],size['cols'],0,0))
    os.environ.update(TERM='xterm-256color',PS1='demo$ ',INPUTRC='/dev/null')
    os.execv('/bin/bash',['bash','--noprofile','--norc','-i'])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',size['rows'],size['cols'],0,0))
def drain():
    result=b''
    while select.select([fd],[],[],0.15)[0]:
        result+=os.read(fd,65536)
    return result.decode('utf8','replace')
try:
    initial=drain()
    os.write(fd,b'x'*int(sys.argv[2]))
    typed=drain()
    os.write(fd,b'\x1b[D'*30)
    left=drain()
    os.write(fd,b'\x01')
    home=drain()
    print(json.dumps(dict(initial=initial,typed=typed,left=left,home=home)))
finally:
    os.kill(pid,signal.SIGKILL)
    os.waitpid(pid,0)
    os.close(fd)
`;

try {
  for (const scenario of ['new', 'existing', 'existing-wrapped']) {
    const page=await browser.newPage({viewport:{width:1024,height:768}});
    await page.goto(`http://127.0.0.1:${server.address().port}/${scenario==='new'?'':'?existing'}`);
    await page.waitForFunction(()=>window.launchSize);
    const size=await page.evaluate(()=>window.launchSize);
    const inputLength=scenario==='existing'?100:size.cols+20;
    const child=spawnSync('python3',['-c',python,JSON.stringify(size),String(inputLength)],{encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);
    const packets=JSON.parse(child.stdout);
    packets.initial=`\x1b[8;${size.rows};${size.cols}t${packets.initial}`;
    const states={};

    for(const [name,data] of Object.entries(packets)){
      await page.evaluate(async data=>{
        window.feed(data);
        await new Promise(resolve=>setTimeout(resolve,0));
        await new Promise(resolve=>window.realTerminal.write('',resolve));
      },data);
      states[name]=await page.evaluate(()=>{const b=window.realTerminal.buffer.active;

      return {x:b.cursorX,y:b.cursorY,base:b.baseY};});
    }

    const columns=await page.evaluate(()=>window.realTerminal.cols);
    assert.equal(columns,size.cols,'xterm must use the shared shell width');

    if(inputLength+6>size.cols) assert.ok(states.left.y+states.left.base < states.typed.y+states.typed.base,'Left must move back across the wrapped line');
    assert.equal(states.home.x,6,'Ctrl+A must reach the beginning of input after the prompt');
    assert.equal(states.home.y+states.home.base,states.initial.y+states.initial.base,'Ctrl+A must reach the original prompt line');
    console.log(`PASS ${scenario}: shell and xterm use ${columns} columns; cursor reaches the original prompt`);
    await page.close();
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
