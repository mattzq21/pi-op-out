import { build } from 'esbuild';
import { daemonImports } from '../../scripts/daemon-imports.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { afterAll } from 'bun:test';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { developmentEndpointKey } from '../../daemon/src/environment';
import { linkTestPi } from '../pi-install.mjs';
export { fakePi } from '../pi-install.mjs';

const root = resolve(import.meta.dir, '../..');
const bundles = new Map<string, Promise<string>>();

const runningLocals = new Set<() => Promise<void>>();
const runningRemotes = new Set<() => Promise<void>>();
if (/\.test\.[cm]?[jt]s$/.test(Bun.main)) afterAll(async () => {
  const failures: string[] = [];
  for (const running of [runningLocals, runningRemotes]) {
    for (const stop of [...running]) await stop().catch((error: Error) => { failures.push(error.message); });
  }
  if (failures.length) throw new Error('Could not stop the daemons that the tests left running:\n' + failures.join('\n'));
}, 120_000);

export interface BuildOptions { development?: boolean; projectRoot?: string; fakeTailscale?: boolean; unusedStopMs?: number }

export function daemonExecutable(options: BuildOptions = {}): Promise<string> {
  if (process.env.PIOP_TEST_DAEMON_UNIT) throw new Error('A daemon unit test must not start the daemon');
  const development = options.development === true;
  if (!development && !options.fakeTailscale && options.unusedStopMs === undefined && process.env.PIOP_TEST_DAEMON_EXECUTABLE) {
    return Promise.resolve(process.env.PIOP_TEST_DAEMON_EXECUTABLE);
  }
  const project = development ? (options.projectRoot ?? root).replace(/[\\/]+$/, '') : '';
  const unusedStopMs = options.unusedStopMs ?? 300_000;
  const key = development + '\0' + project + '\0' + Boolean(options.fakeTailscale) + '\0' + unusedStopMs;
  let bundled = bundles.get(key);
  if (bundled) return bundled;
  bundled = (async () => {
    const directory = temporaryDirectory('piop-daemon-build-');
    const outfile = join(directory, 'piopd.mjs');
    const placeholder = 'piop-build-' + randomBytes(32).toString('hex');
    await build({
      entryPoints: [join(root, 'daemon/src/main.ts')],
      outfile, bundle: true, platform: 'node', format: 'esm', target: 'esnext', external: ['bun', 'bun:*', 'x11', 'usocket'],
      banner: { js: "#!/usr/bin/env bun\nimport { createRequire as __piopCreateRequire } from 'node:module';\nconst require = __piopCreateRequire(import.meta.url);\nif (process.argv[2] === '--build-id') { process.stdout.write(" + JSON.stringify(placeholder) + " + '\\n'); process.exit(0); }" },
      define: { __PIOP_BUILD_ID__: JSON.stringify(placeholder), __PIOP_DEVELOPMENT__: JSON.stringify(development), __PIOP_PROJECT_DIR__: JSON.stringify(project), __PIOP_UNUSED_STOP_MS__: JSON.stringify(unusedStopMs) },
      keepNames: true, legalComments: 'none', logLevel: 'error', sourcemap: development ? 'inline' : false,
      plugins: [...options.fakeTailscale ? [{
        name: 'fake-tailscale',
        setup(context) { context.onResolve({ filter: /^\.\/tailscale_system$/ }, () => ({ path: join(root, 'test/daemon/tailscale-system-fake.ts') })); },
      }] : [], daemonImports()],
    });
    const bundle = readFileSync(outfile, 'utf8');
    const buildId = 'piop-build-' + createHash('sha256').update(bundle.replaceAll(placeholder, '')).digest('hex');
    writeFileSync(outfile, bundle.replaceAll(placeholder, buildId));
    chmodSync(outfile, 0o755);
    return outfile;
  })();
  bundles.set(key, bundled);
  return bundled;
}

export function daemonDirectory(home: string, options: BuildOptions = {}): string {
  if (options.development !== true) return join(home, '.piop');
  return join(home, '.piop-dev/daemons', developmentEndpointKey((options.projectRoot ?? root).replace(/[\\/]+$/, '')));
}

export function temporaryDirectory(prefix = 'piop-test-'): string {
  const unit = process.env.PIOP_TEST_UNIT;
  const base = process.env.CACHE_DIRECTORY;
  const path = base ? relative(base, tmpdir()) : '..';
  if (!unit || !readFileSync('/proc/self/cgroup', 'utf8').trim().endsWith('/' + unit)
    || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) {
    throw new Error('Run daemon tests with bun run test:daemon, or python3 scripts/test-run.py bun test <test file>');
  }
  return mkdtempSync(join(tmpdir(), prefix));
}

export function fakeProgram(bin: string, name: string, source: string): string {
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

const FAKE_SSH = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -F|-o|-p|-i|-l) shift 2;; -*) shift;; *) break;; esac; done
target=$1; shift
remote="$(cd "$(dirname "$0")/.." && pwd)/.test-remotes/$target"
[ -d "$remote" ] || { echo "ssh: Could not resolve hostname $target: Name or service not known" >&2; exit 255; }
[ ! -e "$remote/.ssh-fail" ] || { cat "$remote/.ssh-fail" >&2; exit 255; }
[ ! -x "$remote/.ssh-hold" ] || exec "$remote/.ssh-hold"
cd "$remote" && HOME="$remote" PIOP_CLIENT_BIND=127.0.0.1:0 exec sh -c "$*"
`;

export interface RemoteMachine { id: string; name: string; target: string; home: string; stop(): Promise<void> }

export async function remoteMachine(daemon: TestDaemon, id: string, name = id, target = id): Promise<RemoteMachine> {
  const executable = await daemonExecutable();
  const home = join(daemon.home, '.test-remotes', target);
  mkdirSync(join(home, '.bun/bin'), { recursive: true });
  await linkTestPi(home);
  symlinkSync(executable, join(home, '.bun/bin/piopd'));
  const env = { ...process.env, HOME: home, PIOP_CLIENT_BIND: '127.0.0.1:0' };
  const stop = () => control(executable, 'stop', env).then(() => {});
  runningRemotes.add(stop);
  return { id, name, target, home, stop };
}

type RemoteSetting = { id: string; name: string; target: string; enabled?: boolean; piPath?: string; unreachable?: boolean };

export async function useRemotes(client: Client, remotes: RemoteSetting[]): Promise<void> {
  const settings = await client.invoke('load_app_settings');
  settings.hosts = remotes.map(remote => ({ enabled: remote.enabled ?? true, id: remote.id, name: remote.name, target: remote.target, piPath: remote.piPath ?? '~/.bun/bin/piopd' }));
  const saved = await client.invoke('save_app_settings', { settings });
  await synchronizationFinished(client, saved.revision);
  for (const remote of remotes.filter(remote => remote.enabled ?? true)) {
    const result = await client.invoke('home_directory', { hostId: remote.id }).then(() => 'answered', (error: Error) => error.message);
    if (remote.unreachable ? !result.startsWith('Could not attach to ' + remote.name) : result !== 'answered') {
      throw new Error('Remote setup for ' + remote.id + ' gave an unexpected result: ' + result);
    }
  }
}

export function synchronizationFinished(client: Client, revision: number): Promise<any> {
  return client.waitEvent('pi://settings-changed', payload => !('committedRevision' in payload) && payload.revision === revision, 20_000);
}

export function addProviderLogin(home: string, providerId: string, type: 'oauth' | 'api_key' = 'api_key'): void {
  const path = join(home, '.piop/auth.json');
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(join(home, '.piop'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...saved, [providerId]: type === 'oauth'
    ? { type, access: 'test-' + providerId + '-token', refresh: 'test-refresh', expires: Date.now() + 86_400_000 }
    : { type, key: 'test-' + providerId + '-key' } }), { mode: 0o600 });
}

export async function refreshedUsage(client: Client, provider: 'codex' | 'anthropic' | 'opencodeGo' | 'opencodex'): Promise<{ usage?: any; error?: string }> {
  return (await client.invoke('provider_usage', { refresh: true, provider }))[provider] ?? {};
}

function logTail(path: string): string {
  try { return readFileSync(path, 'utf8').split('\n').slice(-30).map(line => line.length > 300 ? line.slice(0, 300) + '…' : line).join('\n'); }
  catch { return '(no log)'; }
}

export type DaemonEvent = { event: string; payload: any };

export interface Client {
  events: DaemonEvent[];
  invoke(command: string, args?: any): Promise<any>;
  failure(command: string, args?: any): Promise<string>;
  waitEvent(name: string | string[], match?: (payload: any) => boolean, timeout?: number): Promise<any>;
  close(): void;
}

export interface TestDaemon extends Client {
  home: string;
  bin: string;
  endpoint: { url: string; token: string };
  connect(): Promise<Client>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  log(): string;
}

async function openClient(url: string, token: string, scope = 'client'): Promise<Client> {
  const socket = new WebSocket(url);
  const events: DaemonEvent[] = [];
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const waiters = new Set<() => void>();
  let closedError: Error | undefined;
  let ready!: { resolve(): void; reject(error: Error): void };
  const readyPromise = new Promise<void>((resolve, reject) => { ready = { resolve, reject }; });
  socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token, scope }));
  socket.onmessage = message => {
    const packet = JSON.parse(String(message.data));
    if (packet.type === 'ready') { ready.resolve(); return; }
    if (packet.type === 'error') { ready.reject(new Error('Daemon rejected the connection: ' + packet.error)); return; }
    if (typeof packet.id === 'number' && pending.has(packet.id)) {
      const entry = pending.get(packet.id)!; pending.delete(packet.id);
      if (typeof packet.error === 'string') entry.reject(new Error(packet.error.replace(/^piop-refused:(pi|daemon)\n/, ''))); else entry.resolve(packet.result);
      return;
    }
    if (typeof packet.event === 'string') { events.push(packet); for (const wake of [...waiters]) wake(); return; }
    if (typeof packet.error === 'string') closedError = new Error('Daemon reported: ' + packet.error);
  };
  const closed = () => {
    closedError ??= new Error('Daemon connection closed');
    ready.reject(closedError);
    for (const entry of pending.values()) entry.reject(closedError);
    pending.clear();
    for (const wake of [...waiters]) wake();
  };
  socket.onclose = closed;
  socket.onerror = closed;
  await readyPromise;
  let next = 1;
  const invoke = (command: string, args: any = {}) => new Promise<any>((done, fail) => {
    if (closedError) { fail(closedError); return; }
    const id = next++;
    pending.set(id, { resolve: done, reject: fail });
    socket.send(JSON.stringify({ id, command, args }));
  });
  const waitEvent = (name: string | string[], match: (payload: any) => boolean = () => true, timeout = 10_000) => new Promise<any>((done, fail) => {
    const names = Array.isArray(name) ? name : [name];
    let seen = 0;
    const stop = (error?: Error, payload?: any) => { waiters.delete(check); clearTimeout(timer); if (error) fail(error); else done(payload); };
    const check = () => {
      for (; seen < events.length; seen++) {
        const event = events[seen]!;
        if (names.includes(event.event) && match(event.payload)) { stop(undefined, event.payload); return; }
      }
      if (closedError) stop(closedError);
    };
    const timer = setTimeout(() => stop(new Error('Timed out waiting for event ' + names.join(' or '))), timeout);
    waiters.add(check);
    check();
  });
  return {
    events, invoke, waitEvent,
    failure: async (command, args) => {
      try { await invoke(command, args); } catch (error: any) { return error.message; }
      throw new Error(command + ' unexpectedly succeeded');
    },
    close: () => socket.close(),
  };
}

async function control(executable: string, action: 'start' | 'stop', env: Record<string, string | undefined>): Promise<string> {
  if (action === 'start' && env.HOME) await linkTestPi(env.HOME);
  return new Promise((done, fail) => {
    execFile(executable, [action], { env, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error('piopd ' + action + ' failed: ' + (stderr || error.message).slice(0, 2000)));
      else done(stdout);
    });
  });
}

export async function startDaemon(options: BuildOptions & { home?: string; env?: Record<string, string> } = {}): Promise<TestDaemon> {
  const executable = await daemonExecutable(options);
  const home = options.home ?? temporaryDirectory('piop-home-');
  const bin = join(home, '.test-bin');
  mkdirSync(bin, { recursive: true });
  fakeProgram(bin, 'ssh', FAKE_SSH);
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, PIOP_CLIENT_BIND: '127.0.0.1:0', PIOP_DAEMON_ORIGIN: 'test', PIOP_USAGE_REFRESH_MS: '0', ...options.env };
  const directory = daemonDirectory(home, options);
  const daemonLog = join(directory, 'daemon.log');
  const clients: Client[] = [];
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    for (const client of clients) client.close();
    await control(executable, 'stop', env);
    runningLocals.delete(stop);
  })();
  runningLocals.add(stop);
  try {
    await control(executable, 'start', env);
    const readEndpoint = () => {
      const database = new Database(join(directory, 'sessions.sqlite'), { readonly: true });
      try { return JSON.parse(Buffer.from((database.query("SELECT body FROM application_settings WHERE name='daemon'").get() as any).body).toString('utf8')); }
      finally { database.close(); }
    };
    const endpoint = readEndpoint();
    const connect = async () => { const current = readEndpoint(); const client = await openClient(current.url, current.token); clients.push(client); return client; };
    const main = await connect();
    return {
      ...main, home, bin, endpoint, connect, log: () => logTail(daemonLog),
      stop,
      async dispose() {
        await stop();
        if (!options.home) rmSync(home, { recursive: true, force: true });
      },
    };
  } catch (error: any) {
    await stop().catch(reason => { error.message += '\n' + reason.message; });
    throw new Error(error.message + '\nDaemon log:\n' + logTail(daemonLog));
  }
}

export async function waitForSessions(daemon: TestDaemon, match: (rows: any[]) => boolean): Promise<any[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const seen = new Set(daemon.events.map(event => event.payload));
    const rows = await daemon.invoke('list_sessions');
    if (match(rows)) return rows;
    // A chat that starts or stops working is told by its own event; other list changes by sessions-changed.
    await daemon.waitEvent(['pi://sessions-changed', 'pi://session-running'], payload => !seen.has(payload), Math.max(1, deadline - Date.now()));
  }
}
