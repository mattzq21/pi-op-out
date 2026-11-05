import * as stateRecords from '../daemon/resources/piop-storage/session-records.ts';
import * as sessionNames from '../daemon/resources/piop-storage/session-names.ts';
import { reserve, bind } from "../daemon/resources/session-database/index.ts";
import { connection } from "../daemon/resources/session-database/core.ts";
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { installBroker } from './runtime-events-fixture.mjs';
import { localStorageChannel } from './local-storage-channel.mjs';

export async function buildTraceControls(outfile) {
  if (process.env.PIOP_TEST_DAEMON_UNIT) throw new Error('A daemon unit test must not build the Pi controls');
  await build({ entryPoints: [fileURLToPath(new URL('../daemon/resources/piop-controls/extension.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', external: ['@earendil-works/*'], plugins: [localStorageChannel()],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

export async function publishedTrace(t, content, { folder = '', home: existingHome, cwd, controlsBundle = process.env.PIOP_TEST_CONTROLS_BUNDLE } = {}) {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'piop-public-trace-'));
  const buildDirectory = await mkdtemp(join(home, 'publication-test-'));
  const sessions = join(home, '.piop', 'sessions', folder);
  const source = join(sessions, `source-${randomUUID()}.jsonl`);
  const previousHome = process.env.HOME, previousStorage = process.env.PIOP_STORAGE_DIRECTORY;
  process.env.HOME = home; delete process.env.PIOP_STORAGE_DIRECTORY;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousStorage === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = previousStorage;
    connection(join(home, '.piop')).prepare('DELETE FROM sessions WHERE session_path=?').run(source);
    if (existingHome) { await rm(buildDirectory, { recursive: true, force: true }); await rm(source, { force: true }); }
    else await rm(home, { recursive: true, force: true });
  });
  await mkdir(sessions, { recursive: true });
  const id = reserve(join(home, '.piop'));
  const header = { type: 'session', version: 3, id, cwd: cwd ?? home };
  const user = { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Start' } };
  await writeFile(source, JSON.stringify(header) + '\n' + JSON.stringify(user) + '\n');
  bind(join(home, '.piop'), id, source);
  const outfile = controlsBundle ?? join(buildDirectory, 'operations.mjs');
  if (!controlsBundle) await buildTraceControls(outfile);
  installBroker(t, (path, { count }) => {
    if (path !== '/session-identity') throw new Error('Unexpected storage request');
    return { sessionIds: Array.from({ length: count }, () => reserve(join(home, '.piop'))) };
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
    const name = names.findLast(entry => entry.name?.trim())?.name;
    if (name) sessionNames.nameSession(fork.sessionPath, fork.sessionId, name);
    const parents = new Map(names.filter(entry => typeof entry.id === 'string').map(entry => [entry.id, entry.parentId]));
    const transcript = lines.filter(({ entry }) => entry?.type !== 'session_info').map(({ line, entry }) => {
      if (!entry || !parents.has(entry.parentId)) return line;
      return JSON.stringify(stateRecords.history([...names, entry]).at(-1));
    }).join('\n');
    await writeFile(fork.sessionPath, publishedHeader + '\n' + transcript);
    return fork.sessionPath;
  };
  const path = content === undefined ? undefined : await publish(content);
  return { home, path, id: identities.get(path) };
}
