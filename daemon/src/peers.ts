import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { BUILD_ID, MAX_AGENT_OUTPUT_BYTES, MAX_REQUEST_BYTES, PEER_PROTOCOL_VERSION } from './config';
import { homeDir } from './environment';
import { loadAppSettings } from './settings';
import { remoteHost, remoteLoginCommand, sshBase } from './pi_launch';
import { ensureDesktopSessionsDir, shellQuote, spawnOptions } from './process_io';
import { listLocalSessions, type SessionIndexRuntime } from './session_index';
import * as sessionGroups from './session_groups';
import * as daemonEndpoint from './daemon_endpoint';
import { brokerEnvironment } from './broker';
import { failedStorage, inspectStorage } from './archives';
import { parseSession, serializeSession, type SessionSummary } from './types';
import { Mutex, withTimeout } from './util/sync';
import type { RemoteHost } from './settings_types';
import type { App } from './app';

const REQUEST_TIMEOUT = 660_000;
/** Requests not yet taken by SSH. More than this means the remote side has stopped reading. */
const MAX_UNSENT_BYTES = MAX_REQUEST_BYTES + 16 * 1024 * 1024;

/** One SSH connection to the Piop daemon on another machine. */
export class Connection {
  alive = true;
  sequence = 1;
  logStatus: string | null | undefined;
  pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  readonly prefix = 'peer-' + randomUUID() + ':';
  constructor(readonly daemonId: string, readonly child: ChildProcess) {}

  invoke(command: string, args: any, timeout = REQUEST_TIMEOUT): Promise<any> {
    if (!this.alive) return Promise.reject(new Error('Remote daemon disconnected; reconnect before retrying'));
    const body = JSON.stringify({ id: this.sequence, command, args: args ?? {} }) + '\n';
    const input = this.child.stdin!;
    if (input.writableLength + Buffer.byteLength(body) > MAX_UNSENT_BYTES) {
      console.error('Closing SSH connection: the remote daemon stopped reading requests');
      this.close();
      return Promise.reject(new Error('Remote daemon stopped reading requests; reconnect before retrying'));
    }
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      let sent = false;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!sent) {
          // An unsent request would run whenever SSH resumes, after its caller has given up.
          console.error('Closing SSH connection: a request was not sent before its timeout');
          this.close();
          reject(new Error('Remote daemon stopped reading requests; reconnect before retrying'));
          return;
        }
        reject(new Error('Peer request timed out; it may have completed. Reconnect and refresh before retrying.'));
      }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      input.write(body, error => {
        if (!error) { sent = true; return; }
        this.pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }

  close(): void { try { this.child.kill('SIGKILL'); } catch (error) { console.error('Could not close SSH connection:', error); } }

  disconnected(app: App): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [hostId, [, connection]] of app.peers.connections) if (connection === this) app.removeLogStatus(hostId);
    for (const pending of this.pending.values()) pending.reject(new Error('SSH disconnected; the remote command may have completed. Running sessions remain on the remote daemon.'));
    this.pending.clear();
    for (const [key, route] of app.peers.routes) {
      if (route.connection !== this) continue;
      const [kind, id] = splitKey(key);
      if (kind === 'runtimeId') app.emit('pi://event', { runtimeId: id, hostId: route.hostId, _peer: true, event: { type: 'disconnected' } });
      if (kind === 'terminalId') app.emit('pi://event', { _peer: true, type: 'terminal_exit', terminalId: id });
    }
    app.emit('pi://sessions-changed', { _peer: true });
  }

  private mapResources(state: PeerRuntime, payload: any): string | undefined | false {
    let hostId: string | undefined;
    for (const kind of ['runtimeId', 'terminalId']) {
      const wireId = payload[kind];
      if (typeof wireId !== 'string') continue;
      if (kind === 'terminalId' && wireId.startsWith('shared-terminal-')) continue;
      if (!wireId.startsWith(this.prefix)) return false;
      const id = wireId.slice(this.prefix.length);
      const route = state.routes.get(routeKey(kind, id));
      if (!route || route.connection !== this) return false;
      hostId = route.hostId;
      payload[kind] = id;
    }
    return hostId;
  }

  receive(app: App, packet: any): void {
    if (typeof packet?.id === 'number') {
      const pending = this.pending.get(packet.id);
      if (pending) {
        this.pending.delete(packet.id);
        if (typeof packet.error === 'string') pending.reject(new Error(packet.error)); else pending.resolve(packet.result ?? null);
      }
      return;
    }
    if (!this.alive) return;
    let event = packet?.event;
    if (typeof event !== 'string') return;
    if (event === 'pi://groups-changed' || packet.payload?._peer === true) return;
    if (event === 'pi://daemon-log-status') {
      const failure = packet.payload?.failure;
      if (packet.payload?.hostId !== 'local' || (failure !== null && typeof failure !== 'string')) { console.error('Invalid remote daemon log status'); return; }
      this.logStatus = failure;
      for (const [hostId, [, connection]] of app.peers.connections) if (connection === this) app.setLogStatus(hostId, failure);
      return;
    }
    if (event === 'pi://settings-changed') event = 'pi://host-settings-changed';
    let payload = packet.payload;
    payload = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
    const hostId = this.mapResources(app.peers, payload);
    if (hostId === false) return;
    payload._peer = true;
    if (hostId !== undefined) { payload.hostId = hostId; app.emit(event, payload); return; }
    for (const [alias, [, connection]] of app.peers.connections) {
      if (connection !== this) continue;
      app.emit(event, { ...payload, hostId: alias });
    }
  }
}

interface Route { owner: string; hostId: string; connection: Connection }

/** The last session list read from one remote host, with the host settings used to read it. */
interface RemoteSessionList { target: string; piPath: string; daemonId: string; rows: SessionSummary[] }

function routeKey(kind: string, id: string): string { return kind + '\u0000' + id; }
function splitKey(key: string): [string, string] { const index = key.indexOf('\u0000'); return [key.slice(0, index), key.slice(index + 1)]; }

/** State for connections to Piop daemons on other machines. */
export class PeerRuntime {
  connections = new Map<string, [RemoteHost, Connection]>();
  starting = new Map<string, Mutex>();
  pending = new Map<string, { host: RemoteHost; cancel(): void }>();
  revision = 0;
  routes = new Map<string, Route>();
  running = new Set<string>();
  errors = new Map<string, string>();
  remoteSessions = new Map<string, RemoteSessionList>();
  remoteListing = new Map<string, Promise<void>>();
  remoteListingDirty = new Set<string>();
}

function executable(host: RemoteHost): string {
  const path = host.piPath === 'pi' ? 'piopd' : host.piPath.endsWith('/pi') ? host.piPath.slice(0, -2) + 'piopd' : host.piPath;
  return path.startsWith('~/') ? '"$HOME"/' + shellQuote(path.slice(2)) : shellQuote(path);
}

async function configuredHost(app: App, hostId: string): Promise<RemoteHost> {
  return remoteHost(await loadAppSettings(app), hostId);
}

function cachedConnection(state: PeerRuntime, hostId: string, host: RemoteHost): Connection | undefined {
  const saved = state.connections.get(hostId);
  if (saved && saved[0].target === host.target && saved[0].piPath === host.piPath && saved[1].alive) return saved[1];
  return undefined;
}

export async function connect(app: App, hostId: string): Promise<Connection> {
  const state = app.peers;
  let startup = state.starting.get(hostId);
  if (!startup) { startup = new Mutex(); state.starting.set(hostId, startup); }
  return startup.run(async () => {
    const revision = state.revision;
    const host = await configuredHost(app, hostId);
    const changed = () => new Error('SSH settings changed for ' + host.name + '; retry the command');
    if (state.revision !== revision) throw changed();
    const cached = cachedConnection(state, hostId, host);
    if (cached) return cached;
    const base = sshBase();
    const args = [...base.args!, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', host.target, remoteLoginCommand('exec ' + executable(host) + ' --stdio-client')];
    let child: ChildProcess;
    try { child = spawn(base.program, args, spawnOptions(base, { stdio: ['pipe', 'pipe', 'pipe'] })); }
    catch (error: any) { throw new Error('Could not connect to ' + host.name + ': ' + error.message); }
    const close = () => { try { child.kill('SIGKILL'); } catch (error) { console.error('Could not close SSH connection to ' + host.name + ':', error); } };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => { reject(changed()); close(); }; });
    const pending = { host, cancel };
    state.pending.set(hostId, pending);
    child.stdin!.on('error', error => console.error('SSH input failed for ' + host.name + ':', error));
    try {
      let diagnostics = '';
      const onStderr = (chunk: Buffer) => { if (diagnostics.length < 8192) diagnostics += chunk.toString('utf8'); };
      child.stderr!.on('data', onStderr);
      const detail = () => { const trimmed = diagnostics.trim(); return trimmed ? ' (' + trimmed + ')' : ''; };
      const lines = lineReader(child);
      let ready: any;
      try {
        const line = await withTimeout(Promise.race([lines.next(), cancelled]), daemonEndpoint.STARTUP_TIMEOUT + 30_000, 'SSH handshake timed out');
        ready = line === undefined ? undefined : JSON.parse(line);
      } catch (error: any) { throw new Error('Could not attach to ' + host.name + ': ' + error.message + detail()); }
      const current = await configuredHost(app, hostId);
      if (state.revision !== revision || current.target !== host.target || current.piPath !== host.piPath) throw changed();
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('SSH disconnected from ' + host.name + detail());
      if (ready?.peerProtocol !== PEER_PROTOCOL_VERSION || typeof ready?.daemonId !== 'string') {
        close();
        throw new Error('Could not attach to ' + host.name + '. Install or upgrade piopd on that host.' + detail());
      }
      if (!BUILD_ID || ready.buildId !== BUILD_ID) {
        close();
        throw new Error('Piop daemon build mismatch on ' + host.name + ': local ' + (BUILD_ID || 'unknown') + ', remote ' + (ready.buildId || 'unknown') + '. Install the same piopd build on both hosts and restart the remote daemon.');
      }
      if (ready.daemonId === daemonEndpoint.identity()) { close(); throw new Error('This SSH target is the current daemon; use Local'); }
      child.stderr!.removeListener('data', onStderr);
      let remainder = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        remainder += chunk.toString('utf8');
        const end = remainder.lastIndexOf('\n');
        if (end < 0) { if (remainder.length > 65536) { console.error('SSH ' + host.name + ': ' + remainder); remainder = ''; } return; }
        console.error('SSH ' + host.name + ': ' + remainder.slice(0, end));
        remainder = remainder.slice(end + 1);
      });
      child.stderr!.on('close', () => { if (remainder.trim()) console.error('SSH ' + host.name + ': ' + remainder); });
      const connection = new Connection(ready.daemonId, child);
      const existing = [...state.connections.values()].map(([, other]) => other).find(other => other.daemonId === connection.daemonId && other.alive);
      if (existing) {
        connection.close();
        app.removeLogStatus(hostId);
        state.connections.set(hostId, [host, existing]);
        if (existing.logStatus !== undefined) app.setLogStatus(hostId, existing.logStatus);
        return existing;
      }
      const previous = state.connections.get(hostId);
      app.removeLogStatus(hostId);
      state.connections.set(hostId, [host, connection]);
      previous?.[1].close();
      app.emit('pi://plugins-changed', { hostId, _peer: true });
      void (async () => {
        try {
          for (;;) {
            const line = await lines.next();
            if (line === undefined) break;
            let packet: any;
            try { packet = JSON.parse(line); } catch (error) { console.error('Invalid SSH response from ' + host.name + ':', error); break; }
            connection.receive(app, packet);
          }
        } catch (error) { console.error('SSH reader failed for ' + host.name + ':', error); }
        finally { connection.disconnected(app); connection.close(); }
      })();
      return connection;
    } catch (error) { close(); throw error; }
    finally { if (state.pending.get(hostId) === pending) state.pending.delete(hostId); }
  });
}

/** Splits a child's stdout into lines. Lines longer than 128 MiB end the stream. */
function lineReader(child: ChildProcess): { next(): Promise<string | undefined> } {
  const lines: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let buffer: Buffer[] = []; let length = 0; let ended = false;
  const push = (line: string | undefined) => { const waiter = waiters.shift(); if (waiter) waiter(line); else if (line !== undefined) lines.push(line); };
  child.stdout!.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let index = chunk.indexOf(10); index >= 0; index = chunk.indexOf(10, start)) {
      buffer.push(chunk.subarray(start, index));
      push(Buffer.concat(buffer).toString('utf8'));
      buffer = []; length = 0; start = index + 1;
    }
    if (start < chunk.length) { buffer.push(chunk.subarray(start)); length += chunk.length - start; }
    if (length > 128 * 1024 * 1024) child.kill('SIGKILL');
  });
  const end = () => { if (ended) return; ended = true; for (const waiter of waiters.splice(0)) waiter(undefined); };
  child.stdout!.on('close', end);
  child.on('error', end);
  return { next: () => lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(undefined) : new Promise(resolve => waiters.push(resolve)) };
}

function activeLocalSessions(app: App): Set<string> {
  return new Set([...app.pi.activeAgents.values()].filter(agent => agent.hostId === 'local' && agent.working).map(agent => agent.sessionId).filter((id): id is string => id !== undefined));
}

export async function localSessions(app: App): Promise<any[]> {
  if (!(await loadAppSettings(app)).localEnabled) return [];
  const root = ensureDesktopSessionsDir(homeDir());
  const sessions = await listLocalSessions(app.sessionIndex, root);
  await sessionGroups.attachAssignments(sessions);
  const id = daemonEndpoint.identity();
  const active = activeLocalSessions(app);
  return sessions.map(session => ({ ...serializeSession(session), daemonId: id, isRunning: active.has(session.id) }));
}

async function listRemoteHost(app: App, host: RemoteHost): Promise<RemoteSessionList> {
  let connection: Connection; let value: any;
  try {
    connection = await connect(app, host.id);
    value = await connection.invoke('list_sessions', {});
    app.peers.errors.delete(host.id);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    if (app.peers.errors.get(host.id) !== message) { app.peers.errors.set(host.id, message); app.emit('pi://daemon-error', { hostId: host.id, line: message, _peer: true }); }
    throw error;
  }
  if (!Array.isArray(value)) throw new Error('Invalid peer session list');
  for (const key of [...app.peers.running]) if (key.startsWith(connection.daemonId + '\u0000')) app.peers.running.delete(key);
  for (const row of value) if (row?.isRunning === true && typeof row.id === 'string') app.peers.running.add(connection.daemonId + '\u0000' + row.id);
  const rows = value.map(parseSession);
  for (const row of rows) { row.hostId = host.id; row.hostName = host.name; row.groupId = null; }
  return { target: host.target, piPath: host.piPath, daemonId: connection.daemonId, rows };
}

/** Reads the session list of a remote host and reports a change with pi://sessions-changed. A request during a read starts one more read after it. */
function refreshRemoteHost(app: App, host: RemoteHost): Promise<void> {
  const state = app.peers;
  const running = state.remoteListing.get(host.id);
  if (running) { state.remoteListingDirty.add(host.id); return running; }
  const listing = listRemoteHost(app, host).then(list => {
    const previous = state.remoteSessions.get(host.id);
    state.remoteSessions.set(host.id, list);
    if (JSON.stringify(previous) !== JSON.stringify(list)) app.emit('pi://sessions-changed', { _peer: true });
  }, () => {
    if (state.remoteSessions.delete(host.id)) app.emit('pi://sessions-changed', { _peer: true });
  }).finally(() => {
    state.remoteListing.delete(host.id);
    if (state.remoteListingDirty.delete(host.id)) void refreshRemoteHost(app, host);
  });
  state.remoteListing.set(host.id, listing);
  return listing;
}

/** Lists local and remote sessions. Without waitForRemote, remote hosts give their last read list and are read again in the background. */
export async function allSummaries(app: App, index: SessionIndexRuntime, waitForRemote = false): Promise<SessionSummary[]> {
  const settings = await loadAppSettings(app);
  const sessions = settings.localEnabled ? await listLocalSessions(index, ensureDesktopSessionsDir(homeDir())) : [];
  const hosts = settings.hosts.filter(host => host.enabled);
  const refreshes = hosts.map(host => refreshRemoteHost(app, host));
  if (waitForRemote) await Promise.all(refreshes);
  const lists = new Map<string, RemoteSessionList>();
  for (const host of hosts) {
    const list = app.peers.remoteSessions.get(host.id);
    if (list && list.target === host.target && list.piPath === host.piPath) lists.set(host.id, list);
  }
  const canonical = new Map<string, string>();
  for (const [hostId, list] of lists) if (!canonical.has(list.daemonId)) canonical.set(list.daemonId, hostId);
  for (const [hostId, list] of lists) if (canonical.get(list.daemonId) === hostId) sessions.push(...list.rows.map(row => ({ ...row })));
  await sessionGroups.registerProjects(app, sessions);
  await sessionGroups.attachAssignments(sessions);
  sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return sessions;
}

function register(state: PeerRuntime, kind: string, id: string, route: Route): void {
  const key = routeKey(kind, id);
  const previous = state.routes.get(key);
  if (previous && previous.owner !== route.owner) throw new Error('Resource belongs to another connection');
  if (previous && previous.connection.alive && previous.connection !== route.connection) throw new Error('Detach the resource before moving it to another daemon');
  state.routes.set(key, route);
}

async function routeStorageReport(app: App): Promise<any> {
  let local: any;
  try { local = await inspectStorage(); } catch (error: any) { local = failedStorage('local', 'Local', error?.message ?? String(error)); }
  const hosts: any[] = [local];
  const seen = new Set([daemonEndpoint.identity()]);
  for (const host of (await loadAppSettings(app)).hosts.filter(host => host.enabled)) {
    try {
      const connection = await connect(app, host.id);
      if (seen.has(connection.daemonId)) continue;
      seen.add(connection.daemonId);
      const report = await connection.invoke('storage_report', {});
      const entry = Array.isArray(report?.hosts) ? report.hosts[0] : undefined;
      if (!entry) throw new Error('Peer returned no local storage report');
      hosts.push({ ...entry, hostId: host.id, hostName: host.name });
    } catch (error: any) { hosts.push(failedStorage(host.id, host.name, error?.message ?? String(error))); }
  }
  return { hosts };
}

async function routeListSessions(app: App): Promise<any> {
  const sessions = await allSummaries(app, app.sessionIndex);
  const localId = daemonEndpoint.identity();
  const localRunning = activeLocalSessions(app);
  return sessions.map(session => {
    const row: any = serializeSession(session);
    row.daemonId = app.peers.connections.get(session.hostId)?.[1].daemonId ?? localId;
    row.isRunning = row.daemonId === localId ? localRunning.has(session.id) : app.peers.running.has(row.daemonId + '\u0000' + session.id);
    return row;
  });
}

function existingRoute(state: PeerRuntime, owner: string, args: any): Route | undefined {
  let existing: Route | undefined;
  for (const kind of ['runtimeId', 'terminalId', 'flowId']) {
    const id = args?.[kind];
    if (typeof id !== 'string') continue;
    const route = state.routes.get(routeKey(kind, id));
    if (!route) continue;
    if (route.owner !== owner) throw new Error('Resource belongs to another connection');
    if (existing && existing.connection !== route.connection) throw new Error('Resources belong to different daemons');
    existing = route;
  }
  return existing;
}

const LOCAL_ONLY = ['save_app_settings', 'load_app_settings', 'load_settings_change', 'change_session_groups', 'load_session_groups'];

export async function route(app: App, owner: string, command: string, rawArgs: any): Promise<any | undefined> {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  if (command === 'provider_auth' && typeof args.request?.flowId === 'string') args.flowId = args.request.flowId;
  const state = app.peers;
  if (command === 'storage_report') return routeStorageReport(app);
  if (command === 'list_sessions') return routeListSessions(app);
  const existing = existingRoute(state, owner, args);
  const explicit = typeof args.hostId === 'string' && args.hostId !== 'local' ? args.hostId : undefined;
  let selected: Route;
  if (explicit !== undefined) {
    if (LOCAL_ONLY.includes(command)) throw new Error('Settings belong to the local daemon');
    selected = { owner, hostId: explicit, connection: await connect(app, explicit) };
  } else if (existing) selected = existing;
  else return undefined;
  const staleTerminals = new Set<string>();
  for (const kind of ['runtimeId', 'terminalId']) {
    const creating = (command === 'start_pi' && kind === 'runtimeId') || (command === 'start_terminal' && kind === 'terminalId');
    const id = args[kind];
    if (typeof id !== 'string' || creating) continue;
    const saved = state.routes.get(routeKey(kind, id));
    if (!saved || saved.owner !== owner || saved.connection !== selected.connection) throw new Error('Reconnect to the resource on its owning daemon');
  }
  if (Array.isArray(args.terminalIds)) {
    for (const id of args.terminalIds) {
      if (typeof id !== 'string' || id.startsWith('shared-terminal-')) continue;
      const saved = state.routes.get(routeKey('terminalId', id));
      if (!saved || saved.owner !== owner) throw new Error('Terminal belongs to another connection');
      if (saved.connection !== selected.connection) {
        if (saved.connection.alive || saved.connection.daemonId !== selected.connection.daemonId) throw new Error('Terminal belongs to another connection');
        staleTerminals.add(id);
      }
    }
  }
  for (const kind of ['runtimeId', 'terminalId']) {
    const id = args[kind];
    if (typeof id !== 'string') continue;
    const collision = kind === 'runtimeId' ? app.pi.containsProcess(id) : app.terminals.containsProcess(id);
    if (collision) throw new Error('Resource is already attached locally');
  }
  if (command === 'start_pi') { if (typeof args.runtimeId !== 'string') throw new Error('Missing runtimeId'); register(state, 'runtimeId', args.runtimeId, selected); }
  if (command === 'start_terminal') { if (typeof args.terminalId !== 'string') throw new Error('Missing terminalId'); register(state, 'terminalId', args.terminalId, selected); }
  const forwarded: any = { ...args, hostId: 'local' };
  for (const kind of ['runtimeId', 'terminalId']) if (typeof args[kind] === 'string') forwarded[kind] = selected.connection.prefix + args[kind];
  if (Array.isArray(args.terminalIds)) {
    forwarded.terminalIds = args.terminalIds.filter((id: any) => typeof id === 'string' && !staleTerminals.has(id))
      .map((id: string) => id.startsWith('shared-terminal-') ? id : selected.connection.prefix + id);
  }
  if (command === 'shared_terminal') forwarded.terminalConnectionId = owner;
  const result = !selected.connection.alive && (command === 'stop_pi' || command === 'close_terminal') ? false : await selected.connection.invoke(command, forwarded);
  const closing = command === 'stop_pi' ? 'runtimeId' : command === 'close_terminal' ? 'terminalId' : undefined;
  if (closing && typeof args[closing] === 'string') state.routes.delete(routeKey(closing, args[closing]));
  if (command === 'provider_auth' && typeof result?.flowId === 'string') {
    if (result.status === 'pending') register(state, 'flowId', result.flowId, selected);
    else state.routes.delete(routeKey('flowId', result.flowId));
  }
  return result;
}

export async function detachOwner(app: App, owner: string): Promise<void> {
  const state = app.peers;
  const connections = new Map([...state.connections].map(([id, [host, connection]]) => [connection, host.name + ' (' + id + ')']));
  const owned: Array<[string, Route]> = [];
  for (const [key, route] of [...state.routes]) if (route.owner === owner) { owned.push([key, route]); state.routes.delete(key); }
  for (const [, route] of owned) if (!connections.has(route.connection)) connections.set(route.connection, route.hostId);
  await Promise.all([...connections].map(async ([connection, host]) => {
    if (!connection.alive) return;
    const deadline = Date.now() + 10_000;
    const cleanup = async (command: string, args: any) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Remote cleanup deadline expired');
      try { await connection.invoke(command, args, remaining); }
      catch (error) {
        if (Date.now() >= deadline || !connection.alive) throw error;
        console.error('Remote cleanup failed for ' + host + ' (' + command + '):', error);
      }
    };
    try {
      await cleanup('shared_terminal', { action: 'discard_drafts', terminalConnectionId: owner, hostId: 'local' });
      for (const [key, route] of owned) {
        if (route.connection !== connection) continue;
        const [kind, id] = splitKey(key);
        if (kind === 'flowId') { await cleanup('provider_auth', { hostId: 'local', request: { action: 'cancel', flowId: id } }); continue; }
        const command = kind === 'runtimeId' ? 'stop_pi' : kind === 'terminalId' ? 'close_terminal' : undefined;
        if (command) await cleanup(command, { discardBlank: false, preserveRunning: true, [kind]: connection.prefix + id });
      }
    } catch (error) { console.error('Remote cleanup failed for ' + host + ':', error); }
  }));
}

export async function invalidate(app: App): Promise<void> {
  const state = app.peers;
  let settings;
  try { settings = await loadAppSettings(app); } catch (error) {
    for (const pending of state.pending.values()) pending.cancel();
    console.error('Could not reload SSH settings:', error); return;
  }
  for (const [id, pending] of state.pending) {
    const keep = settings.hosts.some(host => host.enabled && host.id === id && host.target === pending.host.target && host.piPath === pending.host.piPath);
    if (!keep) pending.cancel();
  }
  const removed: Connection[] = [];
  for (const [id, [previous, connection]] of [...state.connections]) {
    const keep = settings.hosts.some(host => host.enabled && host.id === id && host.target === previous.target && host.piPath === previous.piPath);
    if (!keep) { state.connections.delete(id); app.removeLogStatus(id); removed.push(connection); }
  }
  const retained = new Set([...state.connections.values()].map(([, connection]) => connection));
  for (const connection of removed) if (!retained.has(connection)) { connection.disconnected(app); connection.close(); }
}

export function shutdown(app: App): void {
  app.peers.revision += 1;
  for (const pending of app.peers.pending.values()) pending.cancel();
  for (const [, connection] of app.peers.connections.values()) {
    connection.close();
    connection.disconnected(app);
  }
}

export async function ensureRestartSafe(app: App): Promise<void> {
  const local = daemonEndpoint.identity();
  const checked = new Set<string>();
  for (const [host, connection] of [...app.peers.connections.values()]) {
    if (connection.daemonId === local || !connection.alive || checked.has(connection.daemonId)) continue;
    checked.add(connection.daemonId);
    try { await connection.invoke('check_daemon_idle', {}); }
    catch (error: any) { throw new Error('Cannot restart while ' + host.name + ' may have active work: ' + (error?.message ?? error)); }
  }
}

export async function forwardBroker(app: App, hostId: string, path: string, body: any): Promise<any> {
  const connection = await connect(app, hostId);
  body = { ...(body ?? {}), hostId: 'local' };
  return connection.invoke('broker_request', { path, body });
}

export function localBrokerRequest(app: App, path: string, body: any): Promise<any> {
  if (path !== '/orchestration' || (typeof body?.hostId === 'string' && body.hostId !== 'local')) {
    return Promise.reject(new Error('Peer broker requests must target this host'));
  }
  const [port, token] = brokerEnvironment(app.broker);
  const payload = Buffer.from(JSON.stringify(body ?? null));
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, timeout: 610_000,
      headers: { Host: 'localhost', Authorization: 'Bearer ' + token, 'Content-Length': payload.length, Connection: 'close' } }, response => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_AGENT_OUTPUT_BYTES + 65536) { response.destroy(); reject(new Error('Broker response is too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof value?.error === 'string') reject(new Error(value.error)); else resolve(value?.data ?? null);
        } catch (error: any) { reject(new Error(error?.message ?? 'Invalid broker response')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Broker request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}
