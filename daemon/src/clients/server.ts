import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer, isIP, type Socket, type Server as NetServer } from 'node:net';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { run, peerCredentials } from './tailscale_system';
import type { Duplex } from 'node:stream';
import { BUILD_ID, DEVELOPMENT, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PEER_PROTOCOL_VERSION, PROTOCOL_VERSION } from '../environment';
import * as endpoint from '../service';
import * as daemonLog from '../service';
import * as daemonRestart from '../restart';
import { records } from '../../resources/session-database/index.ts';
import * as clientCommands from './commands';
import { refusalText, responseErrorText } from '../pi';
import { detachOwner } from '../lifecycle';
import { ensurePrivateDir, setPrivateFilePermissions } from '../util/private_fs';
import { acceptUpgrade, reject, type WebSocketConnection } from './ws_server';
import { errorText, withTimeout, logFailure } from '../util/sync';
import type { App } from '../app';
import { controlRequest } from '../../../protocol/commands';

const MAX_MESSAGE = MAX_REQUEST_BYTES;
const MAX_OUTGOING_BYTES = MAX_RESPONSE_BYTES;
const MAX_OUTGOING_MESSAGES = 1024;
const MAX_CONNECTIONS = 8;
const EVENTS = ['pi://event', 'pi://stderr', 'pi://settings-changed', 'pi://settings-pending', 'pi://groups-changed', 'pi://sessions-changed', 'pi://session-running', 'pi://daemon-error', 'pi://daemon-log-status', 'pi://provider-auth-changed', 'pi://session-removed', 'pi://session-restored', 'pi://host-settings-changed', 'pi://plugins-changed', 'pi://fast-models-changed', 'pi://agent-definitions-changed', 'pi://daemon-restarting', 'pi://usage-changed'];

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

// owner: the only client that gets the event. Undefined means every client.
interface Broadcast { packet: any; text: string; owner?: string }
type Subscriber = (event: Broadcast) => void;

interface Shared { app: App; subscribers: Set<Subscriber>; handshakes: Slots; connections: Slots; jobs: Slots }

const listeners = new WeakMap<App, Set<NetServer>>();
const sockets = new WeakMap<App, Set<Socket>>();
const published = new WeakMap<App, () => void>();

function trackListener(app: App, server: NetServer): void {
  let active = listeners.get(app);
  if (!active) listeners.set(app, active = new Set());
  active.add(server);
  server.once('close', () => active.delete(server));
  server.on('connection', (socket: Socket) => {
    if (app.clients.closing()) { socket.destroy(); return; }
    let connected = sockets.get(app);
    if (!connected) sockets.set(app, connected = new Set());
    connected.add(socket);
    socket.once('close', () => connected.delete(socket));
  });
}

export function stopAccepting(app: App): void {
  for (const server of listeners.get(app) ?? []) {
    server.close(error => { if (error) console.error('Could not close daemon listener:', error); });
  }
}

export function closeConnections(app: App): void {
  for (const socket of sockets.get(app) ?? []) socket.destroy();
}

export function unpublish(app: App): void {
  const remove = published.get(app);
  published.delete(app);
  if (remove) remove();
}

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

function upgradeServer(shared: Shared, onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): Server {
  const server = createServer((_request, response) => { response.writeHead(426, { Connection: 'close' }); response.end(); });
  trackListener(shared.app, server);
  server.on('connection', (socket: Socket) => {
    const release = shared.handshakes.tryAcquire();
    if (!release) { console.error('Rejected a connection from ' + socket.remoteAddress + ': too many connections are waiting to authenticate'); socket.destroy(); return; }
    (socket as any).piopReleaseHandshake = release;
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
  if (token === undefined && DEVELOPMENT) {
    try {
      const saved = records.read(endpoint.directory(), 'debug-mobile-identity');
      if (saved) token = JSON.parse(saved.toString('utf8')).token;
    }
    catch (error) { if (errorText(error) !== 'Daemon connection is not available') console.error('Could not read the saved daemon endpoint; using a new token: ' + errorText(error)); }
  }
  if (typeof token !== 'string') token = randomUUID() + randomUUID();
  if (token.length < 32) throw new Error('PIOP_MOBILE_TOKEN must contain at least 32 characters');
  const bind = process.env.PIOP_MOBILE_BIND ?? (DEVELOPMENT ? '127.0.0.1:0' : '127.0.0.1:9847');
  const shared: Shared = { app, subscribers: new Set(), handshakes: new Slots(16), connections: new Slots(MAX_CONNECTIONS), jobs: new Slots(16) };
  const secret = token;
  const server = upgradeServer(shared, (request, socket, head) => {
    const ws = acceptUpgrade(request, socket, head, MAX_MESSAGE);
    if (!ws) return;
    const local = isLoopback(request.socket.remoteAddress);
    connection(shared, ws, secret, local, socket).catch(error => console.error('Connection from ' + request.socket.remoteAddress + ' ended: ' + errorText(error))).finally(() => ws.terminate());
  });
  let address: { address: string; port: number };
  try { address = await listen(server, bind); } catch (error) { throw new Error('Client endpoint: ' + errorText(error)); }
  endpoint.publish(address.address, address.port, secret);
  const removals: Array<() => void> = [() => endpoint.unpublish(address.address, address.port, secret)];
  published.set(app, () => { for (const remove of removals) { try { remove(); } catch (error) { console.error('Could not remove the daemon endpoint record: ' + errorText(error)); } } });
  for (const name of EVENTS) {
    app.listenAny(name, (payload, owner) => {
      const packet = { event: name, payload };
      const event = { packet, text: JSON.stringify(packet), owner };
      for (const subscriber of [...shared.subscribers]) subscriber(event);
    });
  }
  await startTailscale(shared);
  if (DEVELOPMENT) removals.push(await startDebug(shared, secret));
  process.stderr.write('Piop daemon listening on ' + bind + ' (TLS proxy required)\n');
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return address === '::1' || address.startsWith('127.');
}

async function startDebug(shared: Shared, token: string): Promise<() => void> {
  const server = upgradeServer(shared, (request, socket, head) => {
    if (request.headers.origin !== undefined && request.headers.origin !== 'https://localhost') { reject(socket, 403, 'Forbidden'); return; }
    const ws = acceptUpgrade(request, socket, head, MAX_MESSAGE);
    if (!ws) return;
    connection(shared, ws, token, isLoopback(request.socket.remoteAddress), socket).catch(error => console.error('Debug connection from ' + request.socket.remoteAddress + ' ended: ' + errorText(error))).finally(() => ws.terminate());
  });
  const root = endpoint.directory();
  const saved = records.read(root, 'debug-mobile-identity');
  const previous = saved ? JSON.parse(saved.toString('utf8')) : undefined;
  const address = await listen(server, process.env.PIOP_DEBUG_MOBILE_BIND ?? previous?.bind ?? '127.0.0.1:0');
  const host = address.address.includes(':') ? '[' + address.address + ']' : address.address;
  records.save(root, 'debug-mobile-identity', JSON.stringify({ bind: host + ':' + address.port, token }));
  const record = JSON.stringify({ url: 'ws://' + host + ':' + address.port, token, protocol: PROTOCOL_VERSION });
  records.save(root, 'debug-mobile', record);
  return () => records.removeIfEqual(root, 'debug-mobile', record);
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

async function connection(shared: Shared, ws: WebSocketConnection, token: string, local: boolean, socket: Duplex): Promise<void> {
  let value: any;
  try { value = await firstText(ws, 'Authentication timeout', 'authentication'); }
  catch (error) { await sendError(ws, errorText(error)); await ws.close(); throw error; }
  if (!authenticated(value, token)) { await sendError(ws, 'Unauthorized'); await ws.close(); throw new Error('Unauthorized'); }
  ws.markAuthenticated();
  const release = shared.connections.tryAcquire();
  if (!release) { await sendError(ws, 'Too many connections'); await ws.close(); throw new Error('Too many connections'); }
  (socket as any).piopReleaseHandshake?.();
  try {
  if (value.scope === 'control') {
    if (!local) { await sendError(ws, 'Daemon control requires a local connection'); throw new Error('Daemon control requires a local connection'); }
    return await controlConnection(shared.app, ws);
  }
  return await serveConnection(shared, ws, value.scope === 'peer');
  } finally { release(); }
}

async function sendError(ws: WebSocketConnection, error: string): Promise<void> {
  await withTimeout(ws.sendText(JSON.stringify({ type: 'error', error })), 2000, 'Send timeout').catch(logFailure('Could not send an error to a client'));
}

async function controlConnection(app: App, ws: WebSocketConnection): Promise<void> {
  await sendReady(ws);
  const request = await firstText(ws, 'Control timeout', 'control');
  const action = request?.action;
  if (typeof action !== 'string') throw new Error('Missing control action');
  if (action !== 'start' && action !== 'stop') throw new Error('Unknown control action');
  const finish = app.clients.beginRequest();
  try {
    if (action === 'stop') app.clients.stop();
    await withTimeout(ws.sendText(JSON.stringify({ type: 'controlled', action })), 10_000, 'Send timeout');
  } finally { finish(); }
  await ws.close();
}

async function sendReady(ws: WebSocketConnection): Promise<void> {
  const packet: any = { type: 'ready', protocol: PROTOCOL_VERSION, backend: 'daemon', peerProtocol: PEER_PROTOCOL_VERSION, daemonId: endpoint.identity(), buildId: BUILD_ID };
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
  let queuedBytes = 0;
  let chain = Promise.resolve();
  let lastSeen = Date.now();
  const commitRestart = async (restartId: string) => {
    try { await daemonRestart.commit(app, restartId); }
    catch (error) { console.error('Could not commit daemon restart ' + restartId + ': ' + errorText(error)); ws.terminate(); }
  };
  const send = (text: string, restartId?: string, id?: number): void => {
    if (ws.closed) { if (restartId !== undefined) void commitRestart(restartId); return; }
    let bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_RESPONSE_BYTES) {
      if (id === undefined) { console.error('Dropped an event to ' + owner + ' of ' + bytes + ' bytes: it exceeds the response limit'); return; }
      text = JSON.stringify({ id, error: 'Response of ' + bytes + ' bytes exceeds the ' + Math.floor(MAX_RESPONSE_BYTES / 1024 / 1024) + ' MiB limit' });
      bytes = Buffer.byteLength(text, 'utf8');
    }
    if (queued >= MAX_OUTGOING_MESSAGES || bytes > MAX_OUTGOING_BYTES - queuedBytes) {
      console.error('Disconnecting ' + owner + ': outgoing queue exceeds ' + MAX_OUTGOING_MESSAGES + ' messages or ' + Math.floor(MAX_OUTGOING_BYTES / 1024 / 1024) + ' MiB');
      ws.terminate();
      if (restartId !== undefined) void commitRestart(restartId);
      return;
    }
    queued += 1;
    queuedBytes += bytes;
    chain = chain.then(async () => {
      queued -= 1;
      try {
        if (ws.closed) { if (restartId !== undefined) await commitRestart(restartId); return; }
        try { await withTimeout(ws.sendText(text), 10_000, 'Send timeout'); }
        catch (error) { console.error('Could not send to ' + owner + ':', error); ws.terminate(); if (restartId !== undefined) await commitRestart(restartId); return; }
        if (restartId !== undefined) await commitRestart(restartId);
      } finally { queuedBytes -= bytes; }
    });
  };
  const subscriber: Subscriber = event => {
    if (event.owner !== undefined && event.owner !== owner) return;
    if (peer && (event.packet.payload?._peer === true || event.packet.event === 'pi://groups-changed' || event.packet.event === 'pi://usage-changed')) return;
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
      try { request = JSON.parse(message.data); } catch (error) { send(JSON.stringify({ error: 'Invalid request: ' + errorText(error) })); console.error('Closing ' + owner + ': request is not valid JSON'); break; }
      if (request?.type === 'ping') {
        try { await withTimeout(ws.sendText(JSON.stringify({ type: 'pong' })), 10_000, 'Send timeout'); } catch { break; }
        continue;
      }
      if (!validRequest(request)) { send(JSON.stringify({ error: 'Invalid request: expected {id, command, args}' })); console.error('Closing ' + owner + ': request has no valid id or command'); break; }
      const id: number = request.id;
      const command: string = request.command;
      const args = request.args === undefined ? {} : request.args;
      if (app.clients.closing()) { send(JSON.stringify({ id, error: refusalText('Piop daemon is shutting down', 'daemon') })); continue; }
      const permit = shared.jobs.tryAcquire() ?? (controlRequest(command, args) ? controls.tryAcquire() : undefined);
      if (!permit) { send(JSON.stringify({ id, error: 'Host is busy; try again' })); continue; }
      const job = (async () => {
        let response: any;
        try {
          const result = peer ? await clientCommands.dispatchPeer(app, owner, command, args) : await clientCommands.dispatch(app, owner, command, args);
          response = { id, result: result === undefined ? null : result };
        } catch (error) { response = { id, error: responseErrorText(error) }; }
        finally { permit(); }
        const restartId = typeof response.result?.restartId === 'string' ? response.result.restartId : undefined;
        send(JSON.stringify(response), restartId, id);
      })();
      pending.add(job);
      job.finally(() => pending.delete(job));
    }
  } finally {
    clearInterval(heartbeat);
    shared.subscribers.delete(subscriber);
    await withTimeout(chain, 2000, 'Send timeout').catch(logFailure('Could not send the last events to a client'));
    await withTimeout(ws.close(), 2000, 'Close timeout').catch(logFailure('Could not close a client connection'));
    ws.terminate();
    await detachOwner(app, owner, false);
    const remaining = [...pending];
    if (remaining.length) Promise.allSettled(remaining).then(() => detachOwner(app, owner, false));
  }
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
      ws.markAuthenticated();
      await serveConnection(shared, ws, false);
    })().catch(error => process.stderr.write('Tailscale connection rejected: ' + errorText(error) + '\n')).finally(() => ws.terminate());
  });
  const server = createNetServer({ pauseOnConnect: true }, socket => {
    const release = shared.connections.tryAcquire();
    if (!release) { process.stderr.write('Tailscale connection rejected: all ' + MAX_CONNECTIONS + ' connection slots are in use\n'); socket.destroy(); return; }
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
  trackListener(shared.app, server);
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(path, () => { server.off('error', rejectListen); resolve(); });
  });
  setPrivateFilePermissions(path);
  process.stderr.write('Tailscale authentication enabled at unix:' + path + ' (host Tailscale account only)\n');
}
