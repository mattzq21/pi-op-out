import { createServer } from "node:http";
import stateRecords from '../daemon/resources/piop-storage/session-records.cjs';
import { reserve, bind, open } from "../daemon/resources/session-database.cjs";
import { createRequire } from 'node:module';
import { openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

export async function buildTraceControls(outfile) {
  await build({ entryPoints: [fileURLToPath(new URL('../daemon/resources/piop-controls/index.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', external: ['@earendil-works/*'], plugins: [storageSchemaImports()],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

export async function publishedTrace(t, traceReader, content, { folder = '', home: existingHome, cwd, controlsBundle = process.env.PIOP_TEST_CONTROLS_BUNDLE } = {}) {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'piop-public-trace-'));
  const buildDirectory = await mkdtemp(join(home, 'publication-test-'));
  const sessions = join(home, '.piop', 'sessions', folder);
  const source = join(sessions, `source-${randomUUID()}.jsonl`);
  const previousHome = process.env.HOME, previousStorage = process.env.PIOP_STORAGE_DIRECTORY;
  process.env.HOME = home; delete process.env.PIOP_STORAGE_DIRECTORY;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousStorage === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = previousStorage;
    const db = open(join(home, '.piop'));
    try { db.prepare('DELETE FROM sessions WHERE session_path=?').run(source); } finally { db.close(); }
    if (existingHome) { await rm(buildDirectory, { recursive: true, force: true }); await rm(source, { force: true }); }
    else await rm(home, { recursive: true, force: true });
  });
  await mkdir(sessions, { recursive: true });
  const id = reserve(join(home, '.piop'));
  const header = { type: 'session', version: 3, id, cwd: cwd ?? home };
  const user = { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Start' } };
  await writeFile(source, JSON.stringify(header) + '\n' + JSON.stringify(user) + '\n');
  const sourceDb = open(join(home, '.piop'));
  try { bind(sourceDb, id, source); } finally { sourceDb.close(); }
  const outfile = controlsBundle ?? join(buildDirectory, 'operations.mjs');
  if (!controlsBundle) await buildTraceControls(outfile);
  const previousBroker = [process.env.PI_DESKTOP_BROKER_URL, process.env.PI_DESKTOP_BROKER_TOKEN];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/session-identity' || request.headers.authorization !== 'Bearer fixture') {
      response.writeHead(400); response.end(JSON.stringify({ error: 'Unexpected storage request' })); return;
    }
    response.setHeader('Content-Type', 'application/json');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { count } = JSON.parse(Buffer.concat(chunks).toString());
    response.end(JSON.stringify({ data: { sessionIds: Array.from({ length: count }, () => reserve(join(home, '.piop'))) } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  process.env.PI_DESKTOP_BROKER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PI_DESKTOP_BROKER_TOKEN = 'fixture';
  t.after(() => {
    server.closeAllConnections(); server.close();
    for (const [index, key] of ['PI_DESKTOP_BROKER_URL', 'PI_DESKTOP_BROKER_TOKEN'].entries()) {
      if (previousBroker[index] === undefined) delete process.env[key]; else process.env[key] = previousBroker[index];
    }
  });
  const { default: controls } = await import(pathToFileURL(outfile));
  const listeners = [];
  controls({ on() {}, events: { on(name, handler) { if (name === 'piop:rpc') listeners.push(handler); }, emit(name, request) { if (name === "hooks-extended") request.hooks = { on: () => () => {} }; } }, appendEntry() { throw new Error('Unexpected history append'); } });
  const request = { command: 'prepare_fork', payload: { mode: 'fork', entryId: 'user' }, ctx: {
    cwd: cwd ?? home,
    sessionManager: { getEntry: () => user, getEntries: () => [user], getBranch: () => [user], getHeader: () => header, getSessionFile: () => source, getSessionId: () => id, getSessionDir: () => sessions },
    ui: { notify(message) { throw new Error(message); } },
  } };
  const identities = new Map();
  const publish = async body => {
    const next = { ...request };
    for (const listener of listeners) listener(next);
    if (!next.ready) throw new Error('Fork command was not registered');
    const fork = await next.ready;
    identities.set(fork.sessionPath, fork.sessionId);
    const publishedHeader = (await readFile(fork.sessionPath, 'utf8')).split('\n')[0];
    const lines = body.split('\n').map(line => {
      try { return { line, entry: JSON.parse(line) }; } catch { return { line }; }
    });
    const names = lines.flatMap(({ entry }) => entry?.type === 'session_info' ? [entry] : []);
    stateRecords.save(fork.sessionPath, [JSON.parse(publishedHeader), ...names]);
    const parents = new Map(names.filter(entry => typeof entry.id === 'string').map(entry => [entry.id, entry.parentId]));
    const transcript = lines.filter(({ entry }) => entry?.type !== 'session_info').map(({ line, entry }) => {
      if (!entry || !parents.has(entry.parentId)) return line;
      return JSON.stringify(stateRecords.history([...names, entry]).at(-1));
    }).join('\n');
    await writeFile(fork.sessionPath, publishedHeader + '\n' + transcript);
    return fork.sessionPath;
  };
  const path = content === undefined ? undefined : await publish(content);
  let tool;
  if (traceReader) {
    traceReader({ registerTool(value) { tool = value; } });
    if (tool?.name !== 'read_trace') throw new Error('Trace tool was not registered');
  }
  const archive = async (sourcePath = path) => {
    const entry = join(buildDirectory, 'archive-command.cjs');
    await build({ entryPoints: ['daemon/resources/storage-transaction-command.cjs'], outfile: entry, bundle: true, platform: 'node', format: 'iife', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()] });
    const { scriptLoader } = createRequire(import.meta.url)('../daemon/resources/host-script.cjs');
    const descriptor = openSync(entry, 'r');
    let reply;
    try {
      reply = JSON.parse(execFileSync('bun', ['-e', scriptLoader, '--', '/proc/self/fd/3'], {
        input: JSON.stringify({ action: 'archive', paths: [sourcePath], root: join(home, '.piop') }),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', descriptor], timeout: 30000,
        env: { ...process.env, BUN_BE_BUN: '1' },
      }));
    } finally { closeSync(descriptor); }
    if (!reply.ok || reply.result?.state !== 'committed') throw new Error(JSON.stringify(reply));
    return reply.result.result.sessions[0].sessionPath;
  };
  return { home, path, id: identities.get(path), publish, archive, read: (query = path) => tool.execute(randomUUID(), { query }, undefined, undefined, { cwd: home }) };
}
