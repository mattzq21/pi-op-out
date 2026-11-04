import { createServer } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';
import assert from 'node:assert/strict';

const screenshots = await mkdtemp(join(tmpdir(), 'piop-mobile-ui-'));

const server = await createServer({ mode: 'mobile', server: { host: '127.0.0.1', port: 0, strictPort: true } });

let browser, page;
const unknownCommands = new Set();

try {
 await server.listen();
 browser = await launchTestBrowser({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
 page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
 const errors=[]; page.on('pageerror', error=>errors.push(error.stack));
  const settings={hiddenModels:[],defaultThinking:'high',defaultFastMode:false,contextWindowCap:200000,contextWindowCapEnabled:true,modelContextWindowCaps:{},autoRetry:true,hiddenUsageIndicators:[],debugMode:false,keybindings:{newConversation:'Ctrl+N',toggleConversations:'Ctrl+B',toggleTerminal:'Ctrl+J',toggleDebugMode:'Ctrl+D',focusComposer:'Ctrl+E',openSettings:'Ctrl+,',toggleQueueHold:'Ctrl+H'},tools:[],skills:[],hosts:[]};
 const state={model:{id:'model',provider:'test',name:'Test model'},thinkingLevel:'high',isStreaming:false,sessionId:'mobile-test',sessionFile:'/tmp/mobile-test.jsonl',messageCount:0,pendingMessageCount:0};
 await page.addInitScript(initialSettings => {
  window.__testClientPreferences = initialSettings;
  window.Capacitor = {
   PluginHeaders: [{name:'ClientPreferences',methods:[{name:'load',rtype:'promise'},{name:'save',rtype:'promise'}]}],
   nativeCallback: (plugin,method) => { throw new Error(`Unexpected native callback: ${plugin}.${method}`); },
   nativePromise: async (plugin,method,options) => {
    if(plugin!=='ClientPreferences') throw new Error(`Unexpected native plugin: ${plugin}`);

    window.__testClientRevision ??= 0;

    if(method==='load') return {settings:window.__testClientPreferences,revision:String(window.__testClientRevision)};

    if(method==='save') {
     if(!(options.initialize&&window.__testClientPreferences)) window.__testClientPreferences=options.settings;
     window.__testClientRevision++;

     return {settings:window.__testClientPreferences,revision:String(window.__testClientRevision),publication:{committed:true,durable:true}};
    }

    throw new Error(`Unexpected native method: ${method}`);
   }
  };
 },settings);
 let connection; const savedSettings=[]; const usageRequests=[];
 await page.routeWebSocket('wss://piop.example.test/', ws=> {
  connection=ws;
  ws.onMessage(raw=> {
   const m=JSON.parse(raw);

   if(m.type==='authenticate') { assert.deepEqual(m,{type:'authenticate',mode:'tailscale'}); ws.send(JSON.stringify({type:'ready',protocol:1,backend:'daemon'}));

   return; }

   if(m.type==='ping') return;
   const data={stop_pi:true,load_app_settings:settings,load_settings_change:{settings},plugin_status:{enabled:[],configured:[],revision:'plugins',error:null,plugins:[],queuedCommands:['compact']},create_temporary_chat:{cwd:'/tmp/project',sessionId:'mobile-test'},list_sessions:[],load_session_groups:{version:1,groups:[],assignments:{}},provider_usage:{opencodex:{usage:{accounts:[{id:'a',remainingPercent:96,resetAt:4102444800},{id:'b',remainingPercent:0}]}},codex:{usage:{remainingPercent:80}},anthropic:{usage:{remainingPercent:60},error:'Rate limited'},opencodeGo:{usage:{rolling:{status:'ok',remainingPercent:70},weekly:{status:'ok',remainingPercent:45},monthly:{status:'ok',remainingPercent:30}}}},start_pi:{attached:true},home_directory:'/home/test',is_git_repository:false};
   let result=Object.hasOwn(data,m.command)?data[m.command]:undefined;

   if(m.command==='provider_auth'&&m.args.request.action==='draft_catalog') result={config:{agents:[{name:'default',isDefault:true,model:'test/model',effort:'high',path_systemprompt:'',path_agent_prompt:'',tools:[],skills:[],mcpServers:{}}]},models:[state.model],initialModel:null,initialThinking:'medium',commands:[],commandDetails:[],skills:[]};

   if(m.command==='pi_command') {
   const responses={get_session_revision:{revision:'changed'},get_snapshot:{revision:'snapshot',state,history:{entries:[],leafId:null},queue:{type:'queue_state',pendingMessages:[]},liveTools:[],sequence:0,epoch:'mobile-test'},get_state:state,get_available_models:{models:[state.model]},get_available_thinking_levels:{levels:['high']},get_commands:{commands:[]},get_session_stats:{}};
    result=responses[m.args.command.type]??{};
   }

   if(m.command==='provider_usage') usageRequests.push(m.args);

   if(m.command==='save_app_settings') { savedSettings.push(m.args.settings); result={settings:m.args.settings}; }

   if(result===undefined) { unknownCommands.add(m.command); ws.send(JSON.stringify({id:m.id,error:'Command is not available on the daemon: '+m.command})); return; }

   ws.send(JSON.stringify({id:m.id,result}));
  });
 });
 await page.goto(server.resolvedUrls.local[0]);
 await page.getByLabel('Anchor host address').fill('wss://piop.example.test');
 await page.getByLabel('Host name').fill('Test workspace');
 await page.screenshot({path:join(screenshots,'pairing.png')});
 await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('button',{name:'Toggle conversations'}).waitFor();
 await page.getByRole('textbox',{name:'Message piop'}).waitFor();
 await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="Message piop"]')));
 const usageBadges=await page.locator('.rail-bottom .codex-usage').evaluateAll(elements=>elements.map(element=>({label:element.getAttribute('aria-label'),logo:!!element.querySelector('svg.provider-logo'),text:element.textContent,stale:element.classList.contains('stale')})));
 assert.equal(usageBadges.length,5);
 const pool=await page.locator('.rail-bottom .usage-pool').evaluate(element=>({badges:[...element.querySelectorAll('.codex-usage')].map(badge=>badge.getAttribute('aria-label')),last:element===element.parentElement.lastElementChild,clamp:getComputedStyle(element,'::before').borderLeftStyle}));
 assert.deepEqual([pool.badges.length,pool.last,pool.clamp],[2,true,'solid']);
 assert.match(pool.badges[0],/OCX account usage remaining: 96%, resets /);
 assert.match(pool.badges[1],/OCX account usage remaining: 0%/);
 assert.ok(usageBadges.every(badge=>badge.logo));
 assert.match(usageBadges[0].label,/OpenCode Go usage remaining: 70%/);
 assert.match(usageBadges[1].label,/Anthropic usage remaining: 60%, stale: Rate limited/);
 assert.deepEqual(usageBadges.map(badge=>[badge.stale,badge.text.endsWith(' (stale)')]),[[false,false],[true,true],[false,false],[false,false],[false,false]]);
 assert.match(usageBadges[2].label,/Codex usage remaining: 80%/);
 await page.locator('.rail-bottom button.codex-usage').nth(1).dispatchEvent('click');
 for (let attempt = 0; !usageRequests.some(args => args.provider === 'anthropic'); attempt++) {
  if (attempt === 100) throw new Error('A click on the Anthropic badge did not refresh its usage');
  await new Promise(resolve => setTimeout(resolve, 100));
 }
 assert.deepEqual([usageRequests.at(-1).refresh,usageRequests.at(-1).provider],[true,'anthropic']);
 connection.send(JSON.stringify({event:'pi://event',payload:{type:'session_switched'}}));
 for (let attempt = 0; !savedSettings.some(saved => saved.knownModels?.includes('test/model')); attempt++) {
  if (attempt === 100) throw new Error('The connected model was not saved as a known model');
  await new Promise(resolve => setTimeout(resolve, 100));
 }
 await page.getByRole('textbox',{name:'Message piop'}).fill('First line');
 await page.getByRole('textbox',{name:'Message piop'}).press('Enter');
 assert.equal(await page.getByRole('textbox',{name:'Message piop'}).inputValue(),'First line\n');
 await page.screenshot({path:join(screenshots,'chat.png')});
 assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Toggle conversations'}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('heading',{name:'Client settings',exact:true}).waitFor();
 await page.screenshot({path:join(screenshots,'settings.png')});
 assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Toggle conversations'}).click();
 await page.getByRole('textbox',{name:'Message piop'}).waitFor();
 await page.getByRole('button',{name:'Close conversations'}).waitFor();
 await page.getByRole('button',{name:'Close conversations'}).click({position:{x:370,y:500}});
 connection.close();
 await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor();
 await page.getByRole('button',{name:'Toggle conversations'}).click();
 page.once('dialog', dialog => dialog.accept());
 await page.getByRole('button',{name:'Host',exact:true}).click();
 await page.getByRole('button',{name:'Connect',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Anchor host address').inputValue(),'wss://piop.example.test/');
 assert.equal(await page.getByLabel('Host name').inputValue(),'Test workspace');
 await page.reload();
 await page.getByRole('textbox',{name:'Message piop'}).waitFor();
 await page.getByRole('button',{name:'Toggle conversations'}).click();
 page.once('dialog', dialog => dialog.accept());
 await page.getByRole('button',{name:'Host',exact:true}).click();
 await page.getByRole('button',{name:'Forget',exact:true}).click();
 await page.getByRole('button',{name:'Forget',exact:true}).waitFor({state:'detached'});
 assert.equal(await page.getByLabel('Anchor host address').inputValue(),'');
 await page.reload();
 await page.getByLabel('Anchor host address').waitFor();
 assert.equal(await page.getByLabel('Anchor host address').inputValue(),'');
 assert.equal(await page.getByRole('button',{name:'Forget'}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: phone connection, connected chat, usage badges with OpenCode Go above Codex, multiline entry, settings, drawer, disconnection, saved anchor reconnects after reload, forgotten anchor stays forgotten; no page errors or horizontal overflow');
 console.log(`Screenshots: ${screenshots}`);
} catch (error) {
 try {
  console.error('Unanswered daemon commands:', [...unknownCommands]);
  console.error(await page?.locator('body').innerText({timeout:2000}));
 } catch (diagnosticError) { console.error('Could not collect failure diagnostics:', diagnosticError); }
 throw error;
} finally {
 try { await browser?.close(); } finally { await server.close(); }
}
