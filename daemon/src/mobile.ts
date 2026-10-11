import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer, isIP, type Socket } from 'node:net';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Duplex } from 'node:stream';
import { DEVELOPMENT, MAX_REQUEST_BYTES, PEER_PROTOCOL_VERSION, PROTOCOL_VERSION } from './config';
import * as endpoint from './daemon_endpoint';
import * as daemonLog from './daemon_log';
import * as daemonRestart from './daemon_restart';
import * as records from './settings_records';
import * as mobileCommands from './mobile_commands';
import { responseErrorText } from './storage_transactions';
import { detachOwner } from './lifecycle';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import { acceptUpgrade, reject, type WebSocketConnection } from './ws_server';
import { errorText, withTimeout } from './util/sync';
import type { App } from './app';

const MAX_MESSAGE = MAX_REQUEST_BYTES;
const EVENTS = ['pi://event', 'pi://stderr', 'pi://settings-changed', 'pi://groups-changed', 'pi://sessions-changed', 'pi://daemon-error', 'pi://daemon-log-status', 'pi://provider-auth-changed', 'pi://chatgpt-changed', 'pi://session-removed', 'pi://session-restored', 'pi://host-settings-changed', 'pi://plugins-changed', 'pi://daemon-restarting'];

/** A counter that limits how many items may run at once. */
class Slots {
  private used = 0;
  constructor(private limit: number) {}
  tryAcquire(): (() => void) | undefined {
    if (this.used >= this.limit) return undefined;
    this.used += 1;
    let released = false;
    return () => { if (!released) { released = true; this.used -= 1; } };
  }
}

interface Broadcast { packet: any; text: string }
type Subscriber = (event: Broadcast) => void;

/** Values shared by all mobile listeners. */
interface Shared { app: App; subscribers: Set<Subscriber>; connections: Slots; jobs: Slots }

function splitBind(bind: string): [string, number] {
  const index = bind.lastIndexOf(':');
  if (index < 0) throw new Error('invalid socket address syntax');
  let host = bind.slice(0, index);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = Number(bind.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535 || isIP(host) === 0) throw new Error('invalid socket address syntax');
  return [host, port];
}

function listen(server: Server, bind: string): Promise<{ address: string; port: number }> {
  const [host, port] = splitBind(bind);
  return new Promise((resolve, rejectListen) => {
    const fail = (error: Error) => rejectListen(error);
    server.once('error', fail);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', fail);
      const address = server.address();
      if (!address || typeof address === 'string') { rejectListen(new Error('Missing listener address')); return; }
      resolve({ address: address.address, port: address.port });
    });
  });
}

/** An HTTP server that only answers WebSocket upgrades and limits open connections. */
function upgradeServer(shared: Shared, onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): Server {
  const server = createServer((_request, response) => { response.writeHead(426, { Connection: 'close' }); response.end(); });
  server.on('connection', (socket: Socket) => {
    const release = shared.connections.tryAcquire();
    if (!release) { socket.destroy(); return; }
    socket.once('close', release);
    const timer = setTimeout(() => { if (!(socket as any).piopUpgraded) socket.destroy(); }, 10_000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
  server.on('upgrade', (request, socket, head) => {
    (socket as any).piopUpgraded = true;
    onUpgrade(request, socket, head);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

export async function start(app: App): Promise<void> {
  daemonLog.listenStatus(failure => app.setLogStatus('local', failure));
  let token = process.env.PIOP_MOBILE_TOKEN;
  if (token === undefined) {
    try { token = endpoint.read().token; } catch { token = randomUUID() + randomUUID(); }
  }
  if (token.length < 32) throw new Error('PIOP_MOBILE_TOKEN must contain at least 32 characters');
  const bind = process.env.PIOP_MOBILE_BIND ?? (DEVELOPMENT ? '127.0.0.1:0' : '127.0.0.1:9847');
  const shared: Shared = { app, subscribers: new Set(), connections: new Slots(8), jobs: new Slots(16) };
  const secret = token;
  const server = upgradeServer(shared, (request, socket, head) => {
    const ws = acceptUpgrade(request, socket, head, MAX_MESSAGE);
    if (!ws) return;
    const local = isLoopback(request.socket.remoteAddress);
    connection(shared, ws, secret, local).catch(() => undefined).finally(() => ws.terminate());
  });
  let address: { address: string; port: number };
  try { address = await listen(server, bind); } catch (error) { throw new Error('Mobile endpoint: ' + errorText(error)); }
  endpoint.publish(address.address, address.port, secret);
  for (const name of EVENTS) {
    app.listenAny(name, payload => {
      const packet = { event: name, payload };
      const event = { packet, text: JSON.stringify(packet) };
      for (const subscriber of [...shared.subscribers]) subscriber(event);
    });
  }
  await startTailscale(shared);
  if (DEVELOPMENT) await startDebug(shared, secret);
  process.stderr.write('Piop daemon listening on ' + bind + ' (TLS proxy required)\n');
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return address === '::1' || address.startsWith('127.');
}

async function startDebug(shared: Shared, token: string): Promise<void> {
  const server = upgradeServer(shared, (request, socket, head) => {
    if (request.headers.origin !== undefined && request.headers.origin !== 'https://localhost') { reject(socket, 403, 'Forbidden'); return; }
    const ws = acceptUpgrade(request, socket, head, MAX_MESSAGE);
    if (!ws) return;
    connection(shared, ws, token, isLoopback(request.socket.remoteAddress)).catch(() => undefined).finally(() => ws.terminate());
  });
  const address = await listen(server, process.env.PIOP_DEBUG_MOBILE_BIND ?? '127.0.0.1:0');
  const host = address.address.includes(':') ? '[' + address.address + ']' : address.address;
  records.publish(join(endpoint.directory(), 'debug-mobile.json'), JSON.stringify({ url: 'ws://' + host + ':' + address.port, token, protocol: 1 }));
}

function authenticated(value: any, expected: string): boolean {
  const token = typeof value?.token === 'string' ? Buffer.from(value.token, 'utf8') : undefined;
  if (!token) return false;
  const wanted = Buffer.from(expected, 'utf8');
  let difference = token.length ^ wanted.length;
  for (let index = 0; index < wanted.length; index++) difference |= wanted[index]! ^ (token[index] ?? 0);
  return difference === 0 && value.type === 'authenticate';
}

async function firstText(ws: WebSocketConnection, timeoutMessage: string, invalid: string): Promise<any> {
  const first = await withTimeout(ws.next(), 10_000, timeoutMessage);
  if (!first) throw new Error('Connection closed');
  if (first.type !== 'text') throw new Error(invalid === 'control' ? 'Expected text' : 'Expected authentication');
  try { return JSON.parse(first.data); } catch (error) { throw new Error(invalid === 'control' ? errorText(error) : 'Invalid authentication'); }
}

async function connection(shared: Shared, ws: WebSocketConnection, token: string, local: boolean): Promise<void> {
  const value = await firstText(ws, 'Authentication timeout', 'authentication');
  if (!authenticated(value, token)) { await ws.close(); throw new Error('Unauthorized'); }
  if (value.scope === 'control') {
    if (!local) throw new Error('Daemon control requires a local connection');
    return controlConnection(shared.app, ws);
  }
  return serveConnection(shared, ws, value.scope === 'peer');
}

async function controlConnection(app: App, ws: WebSocketConnection): Promise<void> {
  await sendReady(ws);
  const request = await firstText(ws, 'Control timeout', 'control');
  const action = request?.action;
  if (typeof action !== 'string') throw new Error('Missing control action');
  if (action === 'start') app.clients.persist();
  else if (action !== 'stop') throw new Error('Unknown control action');
  let failure: unknown;
  try { await ws.sendText(JSON.stringify({ type: 'controlled', action })); } catch (error) { failure = error; }
  if (action === 'stop') app.clients.stop();
  if (failure) throw failure;
  await ws.close();
}

async function sendReady(ws: WebSocketConnection): Promise<void> {
  const packet: any = { type: 'ready', protocol: PROTOCOL_VERSION, backend: 'daemon', peerProtocol: PEER_PROTOCOL_VERSION, daemonId: endpoint.identity() };
  if (DEVELOPMENT) {
    packet.debugProcessId = process.pid;
    packet.debugRuntime = endpoint.debugRuntime();
  }
  await ws.sendText(JSON.stringify(packet));
}

async function serveConnection(shared: Shared, ws: WebSocketConnection, peer: boolean): Promise<void> {
  const client = shared.app.clients.connect();
  try { await serveClient(shared, ws, peer); } finally { client.release(); }
}

function validRequest(value: any): boolean {
  return value && typeof value === 'object' && !Array.isArray(value) && Number.isSafeInteger(value.id) && value.id >= 0 && typeof value.command === 'string';
}

async function serveClient(shared: Shared, ws: WebSocketConnection, peer: boolean): Promise<void> {
  const { app } = shared;
  const controls = new Slots(2);
  const pending = new Set<Promise<void>>();
  const owner = 'client:' + randomUUID();
  let queued = 0;
  let chain = Promise.resolve();
  let lastSeen = Date.now();
  const send = (text: string, restartId?: string): void => {
    if (ws.closed) return;
    queued += 1;
    if (queued > 1024) { ws.terminate(); return; }
    chain = chain.then(async () => {
      queued -= 1;
      if (ws.closed) return;
      try { await withTimeout(ws.sendText(text), 10_000, 'Send timeout'); }
      catch { ws.terminate(); return; }
      if (restartId !== undefined) {
        try { await daemonRestart.commit(app, restartId); }
        catch (error) { console.error(error); ws.terminate(); }
      }
    });
  };
  const subscriber: Subscriber = event => {
    if (peer && (event.packet.payload?._peer === true || event.packet.event === 'pi://groups-changed')) return;
    send(event.text);
  };
  await sendReady(ws);
  shared.subscribers.add(subscriber);
  for (const [hostId, failure] of app.logStatuses) {
    if (peer && hostId !== 'local') continue;
    send(JSON.stringify({ event: 'pi://daemon-log-status', payload: { hostId, failure } }));
  }
  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > 65_000) { ws.terminate(); return; }
    ws.ping().catch(() => ws.terminate());
  }, 20_000);
  try {
    for (;;) {
      const message = await ws.next();
      lastSeen = Date.now();
      if (!message) break;
      if (message.type !== 'text') continue;
      let request: any;
      try { request = JSON.parse(message.data); } catch { break; }
      if (request?.type === 'ping') {
        try { await withTimeout(ws.sendText(JSON.stringify({ type: 'pong' })), 10_000, 'Send timeout'); } catch { break; }
        continue;
      }
      if (!validRequest(request)) break;
      const id: number = request.id;
      const command: string = request.command;
      const args = request.args === undefined ? {} : request.args;
      const control = command === 'stop_pi' || (command === 'pi_command' && args?.command?.type === 'abort');
      const permit = shared.jobs.tryAcquire() ?? (control ? controls.tryAcquire() : undefined);
      if (!permit) { send(JSON.stringify({ id, error: 'Host is busy; try again' })); continue; }
      const job = (async () => {
        let response: any;
        try {
          const result = peer ? await mobileCommands.dispatchPeer(app, owner, command, args) : await mobileCommands.dispatch(app, owner, command, args);
          response = { id, result: result === undefined ? null : result };
        } catch (error) { response = { id, error: responseErrorText(error) }; }
        finally { permit(); }
        const restartId = typeof response.result?.restartId === 'string' ? response.result.restartId : undefined;
        send(JSON.stringify(response), restartId);
      })();
      pending.add(job);
      job.finally(() => pending.delete(job));
    }
  } finally {
    clearInterval(heartbeat);
    shared.subscribers.delete(subscriber);
    await withTimeout(ws.close(), 2000, 'Close timeout').catch(() => undefined);
    ws.terminate();
    await detachOwner(app, owner, false);
    const remaining = [...pending];
    if (remaining.length) Promise.allSettled(remaining).then(() => detachOwner(app, owner, false));
  }
}

function run(program: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve, rejectRun) => {
    execFile(program, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout) => {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) { rejectRun(error); return; }
      if (error && error.killed) { rejectRun(Object.assign(new Error('timeout'), { timeout: true })); return; }
      resolve({ ok: !error, stdout: String(stdout) });
    });
  });
}

async function hostLogin(): Promise<string> {
  let output: { ok: boolean; stdout: string };
  try { output = await run('/usr/bin/tailscale', ['status', '--json']); }
  catch (error: any) { throw new Error(error?.timeout ? 'Tailscale status timed out' : 'Tailscale is not installed'); }
  if (!output.ok) throw new Error("Cannot read the host's Tailscale identity");
  let status: any;
  try { status = JSON.parse(output.stdout); } catch { throw new Error('Invalid Tailscale status'); }
  const tags = status?.Self?.Tags;
  if (status?.BackendState !== 'Running' || (Array.isArray(tags) && tags.length > 0)) throw new Error('Sign the host into a personal Tailscale account to enable mobile access');
  const user = status?.Self?.UserID;
  if (!Number.isSafeInteger(user) || user < 0) throw new Error('Missing Tailscale host user');
  const login = status?.User?.[String(user)]?.LoginName;
  if (typeof login !== 'string' || !login || !/^[\x00-\x7f]*$/.test(login)) throw new Error('Missing Tailscale host login');
  return login;
}

/** Linux socket option values: SOL_SOCKET level and the SO_PEERCRED option. */
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

type GetSockOpt = (fd: number, level: number, option: number, value: any, length: any) => number;
let getsockopt: GetSockOpt | undefined;

/** Loads getsockopt from the C library (glibc or musl) through bun:ffi. */
function loadGetsockopt(): GetSockOpt {
  if (getsockopt) return getsockopt;
  let failure: unknown;
  for (const name of ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']) {
    try {
      const library = dlopen(name, { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
      getsockopt = library.symbols.getsockopt as GetSockOpt;
      return getsockopt;
    } catch (error) { failure = error; }
  }
  throw new Error('Cannot load the C library to read socket credentials: ' + errorText(failure));
}

/** Reads the process and user identity of the other end of a unix socket. */
async function peerCredentials(socket: Socket): Promise<{ pid: number; uid: number }> {
  const fd = (socket as any)._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw new Error('Missing proxy peer socket');
  // struct ucred is three 32-bit integers: pid, uid, gid.
  const credentials = new Int32Array(3);
  const length = new Uint32Array([credentials.byteLength]);
  const result = loadGetsockopt()(fd, SOL_SOCKET, SO_PEERCRED, ptr(credentials), ptr(length));
  if (result !== 0 || length[0] !== credentials.byteLength) throw new Error('Missing proxy peer PID');
  return { pid: credentials[0]!, uid: credentials[1]! };
}

async function verifyProxyPeer(socket: Socket): Promise<void> {
  const peer = await peerCredentials(socket);
  if (peer.uid !== 0) throw new Error('Untrusted Tailscale proxy peer');
  let output: { ok: boolean; stdout: string };
  try { output = await run('/usr/bin/systemctl', ['--system', 'show', 'tailscaled.service', '--property=MainPID', '--value']); }
  catch (error: any) { throw new Error(error?.timeout ? 'Tailscale service lookup timed out' : 'Cannot verify tailscaled system service'); }
  const text = output.stdout.trim();
  const servicePid = /^-?\d+$/.test(text) ? Number(text) : undefined;
  if (!output.ok || servicePid !== peer.pid || peer.pid <= 0) throw new Error('Untrusted Tailscale proxy peer');
}

function removePreviousSocket(path: string): void {
  let stat;
  try { stat = lstatSync(path); } catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
  if (!stat.isSocket()) throw new Error('Tailscale socket path is occupied by a non-socket file');
  unlinkSync(path);
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return origin === 'https://localhost' || origin === 'capacitor://localhost' || (DEVELOPMENT && origin === 'http://localhost:5173');
}

async function startTailscale(shared: Shared): Promise<void> {
  const directory = endpoint.directory();
  ensurePrivateDir(directory);
  const path = join(directory, 'tailscale.sock');
  removePreviousSocket(path);
  const logins = new WeakMap<object, string>();
  const http = createServer((_request, response) => { response.writeHead(426, { Connection: 'close' }); response.end(); });
  http.on('clientError', (_error, socket) => socket.destroy());
  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const login = logins.get(socket);
    const headers = request.headers;
    if (login === undefined || headers['tailscale-funnel-request'] !== undefined || !originAllowed(headers.origin) || headers['tailscale-user-login'] !== login) {
      reject(socket, 403, 'Forbidden', 'Tailscale identity is not authorized');
      process.stderr.write('Tailscale connection rejected: HTTP error: 403 Forbidden\n');
      return;
    }
    (socket as any).piopUpgraded = true;
    const ws = acceptUpgrade(request, socket, head, MAX_MESSAGE);
    if (!ws) return;
    (async () => {
      const packet = await firstText(ws, 'Authentication timeout', 'authentication');
      if (packet?.type !== 'authenticate' || packet?.mode !== 'tailscale') { await ws.close(); throw new Error('Select Tailscale authentication'); }
      await serveConnection(shared, ws, false);
    })().catch(error => process.stderr.write('Tailscale connection rejected: ' + errorText(error) + '\n')).finally(() => ws.terminate());
  });
  const server = createNetServer({ pauseOnConnect: true }, socket => {
    const release = shared.connections.tryAcquire();
    if (!release) { socket.destroy(); return; }
    socket.once('close', release);
    const timer = setTimeout(() => { if (!(socket as any).piopUpgraded) socket.destroy(); }, 10_000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    (async () => {
      await verifyProxyPeer(socket);
      logins.set(socket, await hostLogin());
      http.emit('connection', socket);
      socket.resume();
    })().catch(error => {
      process.stderr.write('Tailscale connection rejected: ' + errorText(error) + '\n');
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(path, () => { server.off('error', rejectListen); resolve(); });
  });
  setPrivateFilePermissions(path);
  process.stderr.write('Tailscale authentication enabled at unix:' + path + ' (host Tailscale account only)\n');
}
