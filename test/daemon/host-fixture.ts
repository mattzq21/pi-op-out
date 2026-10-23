import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { daemonExecutable, startDaemon, temporaryDirectory } from './harness';

let bundle: Promise<string> | undefined;
function hostExecutable(): Promise<string> {
  return bundle ??= (async () => {
    const root = resolve(import.meta.dir, '../..');
    const outfile = join(temporaryDirectory('piop-host-build-'), 'host.mjs');
    await build({
      stdin: { contents: `
import { start } from './daemon/src/host/index';
import { isHostOperationWorker, runHostOperationWorker } from './daemon/src/host_operation_worker';
import { createInterface } from 'node:readline';
if (isHostOperationWorker()) { runHostOperationWorker(); } else {
const output = packet => process.stdout.write(JSON.stringify(packet) + '\\n');
const host = await start(process.env.HOME, '.piop', process.argv[2], output);
const input = createInterface({ input: process.stdin });
input.on('line', line => host.input(JSON.parse(line)));
input.on('close', () => host.input({ type: 'shutdown' }));
process.on('SIGTERM', () => host.input({ type: 'shutdown' }));
output({ type: 'fixture_ready' });
await host.finished;
process.exit(0);
}
`, resolveDir: root, sourcefile: 'host-fixture-entry.ts', loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'esm', target: 'esnext', external: ['bun', 'bun:*'],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      define: { __PIOP_BUILD_ID__: '"host-fixture"', __PIOP_DEVELOPMENT__: 'false', __PIOP_PROJECT_DIR__: '""' },
      keepNames: true, legalComments: 'none', logLevel: 'error',
      plugins: [{ name: 'raw-text', setup(context) {
        context.onResolve({ filter: /^piop-agent-loader$/ }, () => ({ path: join(root, 'extensions/piop-define-agents/daemon-loader.ts') }));
        context.onResolve({ filter: /^\.\.\/app-settings\.cjs$/ }, args => args.importer.includes('/extensions/piop-define-agents/') ? { path: join(root, 'daemon/resources/session-broker/app-settings.cjs') } : undefined);
        context.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }));
        context.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
      } }],
    });
    return outfile;
  })();
}

export interface TestHost {
  home: string;
  events: any[];
  request(packet: any, timeout?: number): Promise<any>;
  waitEvent(match: (packet: any) => boolean, timeout?: number): Promise<any>;
  stop(): Promise<void>;
  finished: Promise<void>;
}

/** Runs the exported Supervisor start/input/finished interface in a child with its own HOME. */
export async function startHost(options: { home?: string; env?: Record<string, string> } = {}): Promise<TestHost> {
  const home = options.home ?? temporaryDirectory('piop-host-home-');
  if (!options.home) {
    const bootstrap = await startDaemon({ home, env: options.env });
    await bootstrap.stop();
  }
  const child = spawn(process.execPath, [await hostExecutable(), await daemonExecutable()], {
    env: { ...process.env, ...options.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: any[] = [];
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const listeners = new Set<() => void>();
  let diagnostics = '', ended: Error | undefined, next = 0;
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  const finished = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      ended = error ?? new Error('Host stopped');
      for (const request of pending.values()) request.reject(ended);
      pending.clear();
      for (const notify of listeners) notify();
      if (error) reject(error); else resolve();
    };
    child.once('error', finish);
    child.once('close', code => finish(code === 0 ? undefined : new Error('Host exited with ' + code + ': ' + diagnostics)));
  });
  void finished.catch(() => {});
  createInterface({ input: child.stdout }).on('line', line => {
    const packet = JSON.parse(line);
    const request = pending.get(packet.id);
    if (packet.type === 'response' && request) {
      pending.delete(packet.id);
      if (packet.error !== undefined) request.reject(new Error(packet.error)); else request.resolve(packet.data);
    } else {
      events.push(packet);
      for (const notify of listeners) notify();
    }
  });
  const waitEvent = (match: (packet: any) => boolean, timeout = 10_000) => new Promise<any>((resolve, reject) => {
    let seen = 0;
    const done = (error?: Error, value?: any) => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(value); };
    const check = () => {
      for (; seen < events.length; seen++) if (match(events[seen])) { done(undefined, events[seen]); return; }
      if (ended) done(ended);
    };
    const timer = setTimeout(() => done(new Error('Host event timed out: ' + diagnostics)), timeout);
    listeners.add(check); check();
  });
  const request = (packet: any, timeout = 10_000) => new Promise<any>((resolve, reject) => {
    if (ended) { reject(ended); return; }
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host request timed out: ' + packet.type + ': ' + diagnostics)); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ ...packet, id }) + '\n', error => {
      if (error) { pending.get(id)?.reject(error); pending.delete(id); }
    });
  });
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    if (!ended) child.stdin.end(JSON.stringify({ type: 'shutdown' }) + '\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await finished; } finally { clearTimeout(timer); }
  })();
  try { await waitEvent(packet => packet.type === 'fixture_ready', 30_000); }
  catch (error) { await stop(); throw error; }
  return { home, events, request, waitEvent, stop, finished };
}
