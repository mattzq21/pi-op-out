import { build } from 'esbuild';
import { daemonImports } from '../../scripts/daemon-imports.mjs';
import { spawn } from 'node:child_process';
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
import { startHost } from './daemon/src/host/index';
import { isHostOperationWorker, runHostOperationWorker } from './daemon/src/host_operation_worker';
import { createInterface } from 'node:readline';
if (isHostOperationWorker()) { runHostOperationWorker(); } else {
const output = packet => process.stdout.write(JSON.stringify(packet) + '\\n');
const events = new Proxy({}, { get: (_, name) => name === 'then' ? undefined : (...args) => output({ type: 'event', name, args }) });
const host = await startHost(process.env.HOME, '.piop', process.argv[2], events, async () => ({ error: 'This host has no broker', transient: false }));
const stop = () => host.shutdown().then(() => process.exit(0));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const { id, method, args } = JSON.parse(line);
  Promise.resolve().then(() => host[method](...args)).then(
    data => output({ type: 'response', id, data: data ?? null }),
    error => output({ type: 'response', id, error: error?.message ?? String(error) }));
});
input.on('close', stop);
process.on('SIGTERM', stop);
output({ type: 'fixture_ready' });
}
`, resolveDir: root, sourcefile: 'host-fixture-entry.ts', loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'esm', target: 'esnext', external: ['bun', 'bun:*'],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      define: { __PIOP_BUILD_ID__: '"host-fixture"', __PIOP_DEVELOPMENT__: 'false', __PIOP_PROJECT_DIR__: '""' },
      keepNames: true, legalComments: 'none', logLevel: 'error',
      plugins: [daemonImports()],
    });
    return outfile;
  })();
}

export interface TestHost {
  home: string;
  events: any[];
  // Calls a public method of the Host in the fixture process.
  call(method: string, ...args: unknown[]): Promise<any>;
  waitEvent(match: (packet: any) => boolean, timeout?: number): Promise<any>;
  stop(): Promise<void>;
  finished: Promise<void>;
}

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
  const call = (method: string, ...args: unknown[]) => new Promise<any>((resolve, reject) => {
    if (ended) { reject(ended); return; }
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host call timed out: ' + method + ': ' + diagnostics)); }, 30_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => {
      if (error) { pending.get(id)?.reject(error); pending.delete(id); }
    });
  });
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    if (!ended) child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await finished; } finally { clearTimeout(timer); }
  })();
  try { await waitEvent(packet => packet.type === 'fixture_ready', 30_000); }
  catch (error) { await stop(); throw error; }
  return { home, events, call, waitEvent, stop, finished };
}
