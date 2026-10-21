import { randomUUID } from 'node:crypto';
import { STORAGE_DIRECTORY } from './config';
import { homeDir, piExecutable } from './environment';
import { agentResources, contextCapSettings, saveContextCapSettings } from './extensions';
import { remoteHost } from './pi_launch';
import * as host from './host/index';
import { Mutex } from './util/sync';
import type { AppSettings } from './settings_types';
import type { BrokerRuntime } from './broker';
import type { PiRuntime } from './pi_runtime';
import type { App } from './app';

const REQUEST_TIMEOUT = 660_000;

type Pending = { resolve(value: any): void; reject(error: Error): void };

/** A connection to the in-process session host (the "host daemon"). */
export class Daemon {
  alive = true;
  readonly remotePort: number | undefined = undefined;
  readonly agentPrefix: string;
  pending = new Map<string, Pending>();
  supervisor: host.Supervisor | undefined;
  private queued: any[] = [];
  readonly sessionEpochs = new Map<string, string>();

  constructor(readonly hostId: string, readonly connectionConfig: string | undefined) {
    this.agentPrefix = 'daemon:' + hostId + ':' + randomUUID() + ':';
  }

  private send(packet: any): void {
    if (this.supervisor) this.supervisor.input(packet); else this.queued.push(packet);
  }

  attach(supervisor: host.Supervisor): void {
    this.supervisor = supervisor;
    for (const packet of this.queued.splice(0)) supervisor.input(packet);
  }

  async configure(runtime: PiRuntime, settings: AppSettings, hostId: string): Promise<void> {
    const agentRevision = runtime.agentConfigRevisions.get(hostId) ?? 0;
    saveContextCapSettings(settings);
    await this.request({ type: 'configure', configuration: { contextCapSettings: contextCapSettings(settings), settings: agentResources(settings), autoCompaction: true, autoRetry: settings.autoRetry, agentRevision } });
  }

  matchesConnection(settings: AppSettings, hostId: string): boolean {
    try { return connectionConfig(settings, hostId) === this.connectionConfig; } catch { return false; }
  }

  disconnect(app: App, runtime: PiRuntime): void {
    this.alive = false;
    for (const pending of this.pending.values()) pending.reject(new Error('Host daemon disconnected'));
    this.pending.clear();
    this.sessionEpochs.clear();
    const ids = runtime.disconnectDaemon(this);
    for (const key of [...runtime.activeAgents.keys()]) if (key.startsWith(this.agentPrefix) || ids.includes(key)) runtime.activeAgents.delete(key);
    for (const id of ids) app.emit('pi://event', { runtimeId: id, event: { type: 'disconnected' } });
  }

  request(packet: any): Promise<any> {
    if (!this.alive) return Promise.reject(new Error('Host daemon disconnected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Host daemon request timed out')); }, REQUEST_TIMEOUT);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.send({ ...packet, id });
    });
  }

  shutdown(): void { this.send({ type: 'shutdown' }); }

  async waitShutdown(): Promise<void> { await this.supervisor?.finished; }
}

function connectionConfig(settings: AppSettings, hostId: string): string | undefined {
  if (hostId === 'local') return undefined;
  const remote = remoteHost(settings, hostId);
  return JSON.stringify([remote.target, remote.piPath]);
}

/** All open host-daemon connections, by host id. */
export class DaemonRegistry {
  daemons = new Map<string, Daemon>();
  lock = new Mutex();
  get(hostId: string): Daemon | undefined { return this.daemons.get(hostId); }
  snapshot(): Daemon[] { return [...this.daemons.values()]; }
}

async function close(app: App, runtime: PiRuntime, daemon: Daemon): Promise<void> {
  daemon.disconnect(app, runtime);
  daemon.shutdown();
  await daemon.waitShutdown();
}

export function invalidateChanged(app: App, runtime: PiRuntime, settings: AppSettings): Promise<void> {
  return runtime.connections.lock.run(async () => {
    for (const [hostId, daemon] of [...runtime.connections.daemons]) {
      if (daemon.matchesConnection(settings, hostId)) continue;
      await close(app, runtime, daemon);
      runtime.connections.daemons.delete(hostId);
    }
  });
}

export async function updateSettings(app: App, runtime: PiRuntime, settings: AppSettings): Promise<void> {
  for (const [hostId, daemon] of [...runtime.connections.daemons]) {
    try { await daemon.configure(runtime, settings, hostId); }
    catch (error: any) {
      app.emit('pi://daemon-error', { hostId, line: 'Could not synchronize settings: ' + (error?.message ?? error) });
      throw error;
    }
  }
}

export function connect(app: App, runtime: PiRuntime, _broker: BrokerRuntime, settings: AppSettings, hostId: string): Promise<Daemon> {
  if (hostId !== 'local') return Promise.reject(new Error('Remote workers must be managed through their Piop daemon'));
  return runtime.connections.lock.run(async () => {
    const config = connectionConfig(settings, hostId);
    const existing = runtime.connections.daemons.get(hostId);
    if (existing && existing.alive && existing.connectionConfig === config) {
      await existing.configure(runtime, settings, hostId);
      return existing;
    }
    if (existing) await close(app, runtime, existing);
    runtime.connections.daemons.delete(hostId);
    const daemon = new Daemon(hostId, config);
    const supervisor = await host.start(homeDir(), STORAGE_DIRECTORY, piExecutable(), packet => {
      if (!daemon.alive) return;
      try { handlePacket(app, daemon, hostId, packet); } catch (error) { console.error('Host packet failed:', error); }
    });
    daemon.attach(supervisor);
    supervisor.finished.then(() => { if (daemon.alive) daemon.disconnect(app, app.pi); });
    runtime.connections.daemons.set(hostId, daemon);
    try { await daemon.configure(runtime, settings, hostId); }
    catch (error) {
      await close(app, runtime, daemon);
      runtime.connections.daemons.delete(hostId);
      throw error;
    }
    return daemon;
  });
}

export function spec(command: { program: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> }): any {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(command.env ?? {})) if (value !== undefined) env[key] = value;
  return { program: command.program, args: command.args ?? [], cwd: command.cwd ?? null, env };
}

function updateAgentEvent(app: App, packet: any): void {
  const id = packet.runtimeId;
  if (typeof id !== 'string') return;
  const agent = app.pi.activeAgents.get(id);
  if (!agent) return;
  switch (packet.event?.type) {
    case 'agent_start': agent.working = true; break;
    case 'agent_settled': agent.working = false; break;
    case 'ownership_lost': agent.working = false; agent.messageable = true; break;
  }
}

function handleEvent(app: App, connection: Daemon, packet: any): void {
  updateAgentEvent(app, packet);
  if (packet.event?.type === 'disconnected' && typeof packet.runtimeId === 'string') {
    if (!app.pi.disconnectProcess(packet.runtimeId, connection)) return;
    app.pi.activeAgents.delete(packet.runtimeId);
  }
  app.emit('pi://event', { runtimeId: packet.runtimeId ?? null, event: packet.event ?? null });
}

function handleSessionState(app: App, connection: Daemon, hostId: string, packet: any): void {
  const state = packet.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  const key = connection.agentPrefix + (typeof packet.sessionKey === 'string' ? packet.sessionKey : '');
  const working = packet.working === true;
  const sessionId = typeof state.sessionId === 'string' ? state.sessionId : undefined;
  if (sessionId !== undefined) {
    for (const agent of app.pi.activeAgents.values()) if (agent.hostId === hostId && agent.sessionId === sessionId) agent.working = working;
  }
  if (typeof packet.epoch === 'string') connection.sessionEpochs.set(key, packet.epoch);
  app.pi.activeAgents.set(key, { hostId, sessionId, sessionPath: typeof state.sessionFile === 'string' ? state.sessionFile : undefined, working, messageable: packet.messageable === true });
  app.emit('pi://sessions-changed', null);
}

function handlePacket(app: App, connection: Daemon, hostId: string, packet: any): void {
  switch (packet?.type) {
    case 'response': {
      const pending = typeof packet.id === 'string' ? connection.pending.get(packet.id) : undefined;
      if (!pending) return;
      connection.pending.delete(packet.id);
      if (typeof packet.error === 'string') pending.reject(new Error(packet.error)); else pending.resolve(packet.data ?? null);
      return;
    }
    case 'event': return handleEvent(app, connection, packet);
    case 'session_state': return handleSessionState(app, connection, hostId, packet);
    case 'session_closed': {
      const key = connection.agentPrefix + (typeof packet.sessionKey === 'string' ? packet.sessionKey : '');
      if (typeof packet.epoch !== 'string' || connection.sessionEpochs.get(key) !== packet.epoch) return;
      connection.sessionEpochs.delete(key);
      app.pi.activeAgents.delete(key);
      app.emit('pi://sessions-changed', null);
      return;
    }
    case 'session_removed': app.emit('pi://session-removed', { hostId, sessionId: packet.sessionId ?? null, sessionPath: packet.sessionPath ?? null }); return;
    case 'stderr': app.emit('pi://stderr', packet); return;
    case 'provider_auth_changed': app.emit('pi://provider-auth-changed', { hostId, flow: packet.flow ?? null }); return;
    case 'plugins_changed': app.emit('pi://plugins-changed', { hostId }); return;
    case 'fast_models_changed': app.emit('pi://fast-models-changed', { hostId }); return;
    case 'diagnostic': app.emit('pi://daemon-error', { hostId, line: packet.line ?? null }); return;
    case 'sessions_changed': app.emit('pi://sessions-changed', null); return;
  }
}
