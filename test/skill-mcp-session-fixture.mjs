import { execFileSync, fork } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { build } from 'esbuild';
import database from '../daemon/resources/session-database.cjs';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (!existsSync(join(root, 'package.json')) || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== '@earendil-works/pi-coding-agent') { const parent = dirname(root); if (parent === root) throw new Error('Pi not found'); root = parent; }

export async function skillMcpSession(t) {
  const dir = mkdtempSync(join(tmpdir(), 'piop-skill-session-')), children = new Set();
  t.after(async () => {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
    rmSync(dir, { recursive: true, force: true });
  });
  const skill = join(dir, 'skill'); mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: fixture\ndescription: Test MCP\ndisable-model-invocation: true\n---\nUse ping.');
  const pid = join(dir, 'server.pid'), blocked = join(dir, 'blocked'), hanging = join(dir, 'hanging'), server = join(skill, 'server.mjs');
  writeFileSync(server, `import {createInterface} from 'node:readline'; import {existsSync,writeFileSync} from 'node:fs';
if(existsSync(${JSON.stringify(blocked)})) { console.error('fixture cannot start'); process.exit(1); }
writeFileSync(${JSON.stringify(pid)},String(process.pid));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.id===undefined||existsSync(${JSON.stringify(hanging)}))return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'ping',description:'Ping',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'PROVEN_PONG'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
  writeFileSync(join(skill, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server], timeout: 1 } } }));
  const storage = join(dir, 'storage.mjs'), bridge = join(dir, 'bridge.mjs');
  await build({ entryPoints: ['daemon/resources/piop-storage/session-storage.mjs'], outfile: storage, bundle: true, platform: 'node', format: 'esm', plugins: [storageSchemaImports()], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" } });
  const shim = join(dir, 'sdk.mjs');
  writeFileSync(shim, `import {createMcpExtension as native} from ${JSON.stringify(pathToFileURL(join(root,'dist/index.js')).href)}; export const createMcpExtension=()=>native({loadConfig:()=>({servers:[],errors:[]}), logPath:${JSON.stringify(join(dir,'mcp.log'))}});`);
  await build({ entryPoints: ['daemon/resources/mcp-bridge.ts'], outfile: bridge, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: shim, external: true })); } }] });
  const area = join(dir, '.piop'); mkdirSync(join(area, 'sessions'), { recursive: true });
  const id = database.reserve(area), file = join(area, 'sessions', `test_${id}.jsonl`);
  const db = database.open(area); database.bind(db, id, file); db.close();
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: dir }) + '\n'); writeFileSync(join(dir, 'session-path'), file);
  const start = async () => {
    const child = fork('test/fixtures/skill-mcp-agent.mjs', [root, dir, bridge, storage], { env: { ...process.env, HOME: dir, PIOP_STORAGE_DIRECTORY: '.piop' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(child);
    let seq = 0, stderr = ''; const pending = new Map(), events = [], waiters = new Set();
    child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
    child.on('message', message => {
      if (message.id) { const task = pending.get(message.id); pending.delete(message.id); if (message.error) task?.reject(new Error(message.error)); else task?.resolve(message.result); }
      else { events.push(message); for (const waiter of waiters) waiter(); }
    });
    child.on('exit', () => { for (const task of pending.values()) task.reject(new Error(`Worker exited: ${stderr}`)); for (const waiter of waiters) waiter(); });
    const event = (predicate, after = 0) => new Promise((resolve, reject) => {
      const check = () => { const found = events.slice(after).find(predicate); if (found) { finish(); resolve(found); } else if (child.exitCode !== null || child.signalCode !== null) { finish(); reject(new Error(stderr)); } };
      const timer = setTimeout(() => { finish(); reject(new Error(`Worker event timeout: ${stderr}`)); }, 10000);
      const finish = () => { clearTimeout(timer); waiters.delete(check); }; waiters.add(check); check();
    });
    await event(value => value.event === 'ready');
    return { child, event, get eventCount() { return events.length; }, command: body => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); child.send({ ...body, id }); }), async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } };
  };
  return { dir, skill, pid, blocked, hanging, file, start };
}

