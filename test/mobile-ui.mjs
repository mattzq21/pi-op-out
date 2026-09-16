import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const screenshots = await mkdtemp(join(tmpdir(), 'piop-mobile-ui-'));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'mobile', '--host', '127.0.0.1', '--port', '1424', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
 for (let attempt = 0; attempt < 60; attempt++) {
  try { if ((await fetch('http://127.0.0.1:1424')).ok) break; } catch { /* Wait for Vite startup. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
 }
 browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
 const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
 const errors=[]; page.on('pageerror', error=>errors.push(error.stack));
 const settings={worktreeSetupScripts:[],defaultAgent:'default',defaultModel:'test/model',hiddenModels:[],defaultThinking:'high',defaultFastMode:false,contextWindowCap:200000,contextWindowCapEnabled:true,autoCompaction:true,autoRetry:true,debugMode:false,keybindings:{newConversation:'Ctrl+N',toggleConversations:'Ctrl+B',toggleTerminal:'Ctrl+J',toggleDebugMode:'Ctrl+D',focusComposer:'Ctrl+E',openSettings:'Ctrl+,'},tools:[],skills:[],mcpServers:[],hosts:[],dictionaries:[],activeDictionaryIds:[]};
 const state={model:{id:'model',provider:'test',name:'Test model'},thinkingLevel:'high',isStreaming:false,sessionId:'mobile-test',sessionFile:'/tmp/mobile-test.jsonl',messageCount:0,pendingMessageCount:0};
 let connection;
 await page.routeWebSocket('wss://piop.example.test/', ws=> {
  connection=ws;
  ws.onMessage(raw=> {
   const m=JSON.parse(raw);
   if(m.type==='authenticate') { ws.send(JSON.stringify({type:'ready',protocol:1}));return; }
   if(m.type==='ping') return;
   const data={load_app_settings:settings,create_temporary_chat:{cwd:'/tmp/project',sessionId:'mobile-test'},list_sessions:[],load_session_groups:{version:1,groups:[],assignments:{}},voice_configuration:{authenticated:false,helperAvailable:true},codex_usage:{remainingPercent:80},start_pi:{attached:true},home_directory:'/home/test',is_git_repository:false};
   let result=data[m.command]??{};
   if(m.command==='pi_command') {
    const responses={get_snapshot:{state,history:{entries:[],leafId:null},queue:{pendingMessages:[]},liveTools:[],sequence:0,epoch:1},get_state:state,get_available_models:{models:[state.model]},get_available_thinking_levels:{levels:['high']},get_commands:{commands:[]},get_session_stats:{}};
    result=responses[m.args.command.type]??{};
   }
   ws.send(JSON.stringify({id:m.id,result}));
  });
 });
 await page.goto('http://127.0.0.1:1424');
 await page.getByLabel('Host address').fill('wss://piop.example.test');
 await page.getByLabel('Pairing token').fill('test'.repeat(12));
 await page.screenshot({path:join(screenshots,'pairing.png')});
 await page.getByRole('button',{name:'Connect to workspace'}).click();
 await page.getByRole('button',{name:'Toggle conversations'}).waitFor();
 await page.getByRole('textbox',{name:'Message piop'}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('textarea[aria-label="Message piop"]').disabled);
 await page.getByRole('textbox',{name:'Message piop'}).fill('First line');
 await page.getByRole('textbox',{name:'Message piop'}).press('Enter');
 assert.equal(await page.getByRole('textbox',{name:'Message piop'}).inputValue(),'First line\n');
 await page.screenshot({path:join(screenshots,'chat.png')});
 assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Settings',exact:true}).first().click();
 await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
 await page.screenshot({path:join(screenshots,'settings.png')});
 assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 await page.getByRole('button',{name:'Toggle conversations'}).click();
 await page.getByRole('button',{name:'Close conversations'}).waitFor();
 await page.getByRole('button',{name:'Close conversations'}).click({position:{x:370,y:500}});
 connection.close();
 await page.getByRole('button',{name:'Connect to workspace'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: phone pairing, connected chat, multiline entry, settings, drawer, disconnection; no page errors or horizontal overflow');
 console.log(`Screenshots: ${screenshots}`);
} finally {await browser?.close(); server.kill();}
