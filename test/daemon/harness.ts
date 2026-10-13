import { build } from 'esbuild';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { developmentEndpointKey } from '../../daemon/src/config';

const root = resolve(import.meta.dir, '../..');
const bundles = new Map<string, Promise<string>>();

/** A development build runs like "scripts/build-daemon.mjs --debug": it is scoped to a project directory. */
export interface BuildOptions { development?: boolean; projectRoot?: string }

/** Bundles the daemon the same way scripts/build-daemon.mjs does, without compiling a release build to a binary. */
export function daemonExecutable(options: BuildOptions = {}): Promise<string> {
  const development = options.development === true;
  const project = development ? (options.projectRoot ?? root).replace(/[\\/]+$/, '') : '';
  const key = development + '\0' + project;
  let bundled = bundles.get(key);
  if (bundled) return bundled;
  bundled = (async () => {
    const directory = temporaryDirectory('piop-daemon-build-');
    const outfile = join(directory, 'piopd.mjs');
    const placeholder = 'piop-build-' + randomBytes(32).toString('hex');
    await build({
      entryPoints: [join(root, 'daemon/src/main.ts')],
      outfile, bundle: true, platform: 'node', format: 'esm', target: 'esnext', external: ['bun', 'bun:*'],
      banner: { js: "#!/usr/bin/env bun\nimport { createRequire as __piopCreateRequire } from 'node:module';\nconst require = __piopCreateRequire(import.meta.url);\nif (process.argv[2] === '--build-id') { process.stdout.write(" + JSON.stringify(placeholder) + " + '\\n'); process.exit(0); }" },
      define: { __PIOP_BUILD_ID__: JSON.stringify(placeholder), __PIOP_DEVELOPMENT__: JSON.stringify(development), __PIOP_PROJECT_DIR__: JSON.stringify(project) },
      keepNames: true, legalComments: 'none', logLevel: 'error', sourcemap: development ? 'inline' : false,
      plugins: [{
        name: 'raw-text',
        setup(context) {
          context.onResolve({ filter: /^piop-agent-loader$/ }, () => ({ path: join(root, 'extensions/piop-define-agents/daemon-loader.ts') }));
          context.onResolve({ filter: /^\.\.\/app-settings\.cjs$/ }, args => args.importer.includes('/extensions/piop-define-agents/') ? { path: join(root, 'daemon/resources/session-broker/app-settings.cjs') } : undefined);
          context.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }));
          context.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
        },
      }],
    });
    // Same build ID rule as scripts/build-daemon.mjs: a hash of the bundle without its placeholder.
    const bundle = readFileSync(outfile, 'utf8');
    const buildId = 'piop-build-' + createHash('sha256').update(bundle.replaceAll(placeholder, '')).digest('hex');
    writeFileSync(outfile, bundle.replaceAll(placeholder, buildId));
    chmodSync(outfile, 0o755);
    return outfile;
  })();
  bundles.set(key, bundled);
  return bundled;
}

/** The directory that holds the daemon endpoint, its log and its settings database for a build. Development builds use .piop-dev. */
export function daemonDirectory(home: string, options: BuildOptions = {}): string {
  if (options.development !== true) return join(home, '.piop');
  return join(home, '.piop-dev/daemons', developmentEndpointKey((options.projectRoot ?? root).replace(/[\\/]+$/, '')));
}

export function temporaryDirectory(prefix = 'piop-test-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  atTestExit('rm -rf -- ' + shellQuote(directory));
  return directory;
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

let janitor: ChildProcess | undefined;

/**
 * Runs a shell command when the test process ends in any way, last registered first. Bun's test runner does not
 * run process exit handlers, so a separate process waits for its input pipe to close and then runs the commands.
 * This is only a fallback for runs that end without their teardown. Its output goes to janitorLog.
 */
export const janitorLog = join(tmpdir(), 'piop-test-janitor-' + process.pid + '.log');

export function atTestExit(command: string): void {
  if (!janitor) {
    janitor = spawn('sh', ['-c', 'f=$(mktemp) && cat > "$f"; tac "$f" | sh -x; unlink "$f"'], { stdio: ['pipe', 'ignore', openSync(janitorLog, 'a')], detached: true });
    janitor.unref();
    (janitor.stdin as any).unref?.();
  }
  janitor.stdin!.write(command.replaceAll('\n', ' ') + '\n');
}

function stopCommand(executable: string, home: string): string {
  // A bounded stop, so one stuck daemon does not hold back the later cleanup.
  return 'HOME=' + shellQuote(home) + ' PIOP_MOBILE_BIND=127.0.0.1:0 timeout -k 5 30 ' + shellQuote(executable) + ' stop';
}

/** Writes an executable script into a directory that tests put first on PATH. */
export function fakeProgram(bin: string, name: string, source: string): string {
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

/** Last lines of a log with long lines cut, so failures stay readable. */
/**
 * A fake ssh client: the target names a directory in .test-remotes next to the fake-program directory, and the
 * command runs there with that directory as HOME. A target without a directory fails like an unreachable host.
 */
const FAKE_SSH = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -F|-o|-p|-i|-l) shift 2;; -*) shift;; *) break;; esac; done
target=$1; shift
remote="$(cd "$(dirname "$0")/.." && pwd)/.test-remotes/$target"
[ -d "$remote" ] || { echo "ssh: Could not resolve hostname $target: Name or service not known" >&2; exit 255; }
[ ! -e "$remote/.ssh-fail" ] || { cat "$remote/.ssh-fail" >&2; exit 255; }
[ ! -x "$remote/.ssh-hold" ] || exec "$remote/.ssh-hold"
cd "$remote" && HOME="$remote" PIOP_MOBILE_BIND=127.0.0.1:0 exec sh -c "$*"
`;

export interface RemoteMachine { id: string; name: string; target: string; home: string; stop(): Promise<void> }

/**
 * Creates a remote machine for the daemon: its own HOME reached through the fake ssh, with piopd installed in
 * ~/.bun/bin like a user install. Its daemon starts on demand when the local daemon attaches with --stdio-client.
 */
export async function remoteMachine(daemon: TestDaemon, id: string, name = id, target = id): Promise<RemoteMachine> {
  const executable = await daemonExecutable();
  const home = join(daemon.home, '.test-remotes', target);
  mkdirSync(join(home, '.bun/bin'), { recursive: true });
  symlinkSync(executable, join(home, '.bun/bin/piopd'));
  const env = { ...process.env, HOME: home, PIOP_MOBILE_BIND: '127.0.0.1:0' };
  atTestExit(stopCommand(executable, home));
  return {
    id, name, target, home,
    stop: () => control(executable, 'stop', env).then(() => {}),
  };
}

/** Adds remote machines to the saved settings. */
type RemoteSetting = { id: string; name: string; target: string; enabled?: boolean; piPath?: string; unreachable?: boolean };

/**
 * Saves the remote machines and waits until the settings synchronization pass for that save has finished, which is
 * the "pi://settings-changed" event without committedRevision. That pass invalidates SSH connections again. Then
 * each enabled machine must answer, and each machine marked unreachable must fail to attach.
 */
export async function useRemotes(client: Client, remotes: RemoteSetting[]): Promise<void> {
  const settings = await client.invoke('load_app_settings');
  // An explicit piopd path, because the PATH of this machine also reaches the user's own piopd.
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

/** Resolves when the background settings synchronization pass has published the saved revision. */
export function synchronizationFinished(client: Client, revision: number): Promise<any> {
  return client.waitEvent('pi://settings-changed', payload => !('committedRevision' in payload) && payload.revision === revision, 20_000);
}

function logTail(path: string): string {
  try { return readFileSync(path, 'utf8').split('\n').slice(-30).map(line => line.length > 300 ? line.slice(0, 300) + '…' : line).join('\n'); }
  catch { return '(no log)'; }
}

export type DaemonEvent = { event: string; payload: any };

export interface Client {
  events: DaemonEvent[];
  invoke(command: string, args?: any): Promise<any>;
  /** Resolves with the error message of a failed command. */
  failure(command: string, args?: any): Promise<string>;
  waitEvent(name: string, match?: (payload: any) => boolean, timeout?: number): Promise<any>;
  close(): void;
}

export interface TestDaemon extends Client {
  home: string;
  bin: string;
  /** The mobile WebSocket address and its token, for tests that speak the protocol directly. */
  endpoint: { url: string; token: string };
  connect(): Promise<Client>;
  stop(): Promise<void>;
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
      if (typeof packet.error === 'string') entry.reject(new Error(packet.error)); else entry.resolve(packet.result);
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
  const waitEvent = (name: string, match: (payload: any) => boolean = () => true, timeout = 10_000) => new Promise<any>((done, fail) => {
    let seen = 0;
    const stop = (error?: Error, payload?: any) => { waiters.delete(check); clearTimeout(timer); if (error) fail(error); else done(payload); };
    const check = () => {
      for (; seen < events.length; seen++) {
        const event = events[seen]!;
        if (event.event === name && match(event.payload)) { stop(undefined, event.payload); return; }
      }
      if (closedError) stop(closedError);
    };
    const timer = setTimeout(() => stop(new Error('Timed out waiting for event ' + name)), timeout);
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

function control(executable: string, action: 'start' | 'stop', env: Record<string, string | undefined>, launcher: string[] = []): Promise<string> {
  return new Promise((done, fail) => {
    const [program, ...args] = [...launcher, executable, action];
    execFile(program!, args, { env, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error('piopd ' + action + ' failed: ' + (stderr || error.message).slice(0, 2000)));
      else done(stdout);
    });
  });
}

/**
 * Starts a real daemon with its own HOME, its own mobile port and a fake-program directory first on PATH.
 * It uses the same public launch path as users: "piopd start" returns once the daemon answers on its control socket.
 */
export async function startDaemon(options: BuildOptions & { home?: string; env?: Record<string, string>; launcher?: string[] } = {}): Promise<TestDaemon> {
  const executable = await daemonExecutable(options);
  const home = options.home ?? temporaryDirectory('piop-home-');
  const bin = join(home, '.test-bin');
  mkdirSync(bin, { recursive: true });
  fakeProgram(bin, 'ssh', FAKE_SSH);
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, PIOP_MOBILE_BIND: '127.0.0.1:0', ...options.env };
  const directory = daemonDirectory(home, options);
  const daemonLog = join(directory, 'daemon.log');
  const clients: Client[] = [];
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    for (const client of clients) client.close();
    await control(executable, 'stop', env);
  })();
  // A test process that ends without its teardown still stops the daemon.
  atTestExit(stopCommand(executable, home));
  try {
    await control(executable, 'start', env, options.launcher);
    const database = new Database(join(directory, 'sessions.sqlite'), { readonly: true });
    let endpoint: any;
    try { endpoint = JSON.parse(Buffer.from((database.query("SELECT body FROM application_settings WHERE name='daemon.json'").get() as any).body).toString('utf8')); }
    finally { database.close(); }
    const connect = async () => { const client = await openClient(endpoint.url, endpoint.token); clients.push(client); return client; };
    const main = await connect();
    return {
      ...main, home, bin, endpoint, connect, log: () => logTail(daemonLog),
      stop,
    };
  } catch (error: any) {
    await stop().catch(reason => { error.message += '\n' + reason.message; });
    throw new Error(error.message + '\nDaemon log:\n' + logTail(daemonLog));
  }
}
