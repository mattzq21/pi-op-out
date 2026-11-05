import { randomUUID } from 'node:crypto';
import { STORAGE_DIRECTORY, homeDir } from '../environment';
import { agentResources, contextCapSettings } from '../extensions';
import { startHost, type Host, type HostEvents, type SessionClosedReport, type SessionStateReport } from '../host/index';
import type { AppSettings } from '../settings';
import { piBrokerRequest } from './broker';
import type { App } from '../app';

// The Host of this daemon, which runs its Pi sessions in this process, and what the rest of the daemon keeps about it.
export class LocalHost {
  alive = true;
  // Starts the key of each running session in PiRuntime.activeAgents.
  readonly agentPrefix = 'host:' + randomUUID() + ':';
  readonly sessionEpochs = new Map<string, string>();
  private appliedConfiguration: string | undefined;
  host!: Host;

  async configure(settings: AppSettings): Promise<void> {
    const configuration = { contextCapSettings: contextCapSettings(settings), settings: agentResources(settings), autoCompaction: true, autoRetry: settings.autoRetry };
    const key = JSON.stringify(configuration);
    if (key === this.appliedConfiguration) return;
    this.appliedConfiguration = undefined;
    await this.host.applyConfiguration(configuration);
    this.appliedConfiguration = key;
  }

  async stop(app: App): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.sessionEpochs.clear();
    const runtime = app.pi;
    const removed = runtime.disconnectHost(this);
    const ids = removed.map(([id]) => id);
    for (const key of [...runtime.activeAgents.keys()]) if (key.startsWith(this.agentPrefix) || ids.includes(key)) runtime.activeAgents.delete(key);
    for (const key of [...runtime.settingsPendingSessions]) if (key.startsWith(this.agentPrefix)) updateSettingsPending(app, key, false);
    for (const [id, owner] of removed) app.emit('pi://event', { runtimeId: id, event: { type: 'disconnected' } }, owner);
    await this.host.shutdown();
  }
}

export async function startLocalHost(app: App, settings: AppSettings): Promise<LocalHost> {
  if (app.pi.host) throw new Error('The Host has already started');
  const local = new LocalHost();
  local.host = await startHost(homeDir(), STORAGE_DIRECTORY, hostEvents(app, local), (source, request) => piBrokerRequest(app, app.broker, source, request));
  app.pi.host = local;
  try { await local.configure(settings); }
  catch (error) {
    await local.stop(app);
    app.pi.host = undefined;
    throw error;
  }
  return local;
}

// The running Host. The daemon starts it before it accepts clients, and stops it last.
export function localHost(app: App): LocalHost {
  const local = app.pi.host;
  if (!local?.alive) throw new Error('The Host is not running');
  return local;
}

export async function updateSettings(app: App, settings: AppSettings): Promise<void> {
  const local = app.pi.host;
  if (!local?.alive) return;
  try { await local.configure(settings); }
  catch (error: any) {
    app.emit('pi://daemon-error', { hostId: 'local', line: 'Could not synchronize settings: ' + (error?.message ?? error) });
    throw error;
  }
}

export async function stopLocalHost(app: App): Promise<void> {
  await app.pi.host?.stop(app);
}

export function spec(command: { program: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> }): any {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(command.env ?? {})) if (value !== undefined) env[key] = value;
  return { program: command.program, args: command.args ?? [], cwd: command.cwd ?? null, env };
}

function updateSettingsPending(app: App, key: string, pending: boolean): void {
  const sessions = app.pi.settingsPendingSessions;
  if (sessions.has(key) === pending) return;
  if (pending) sessions.add(key); else sessions.delete(key);
  app.emit('pi://settings-pending', { hostId: 'local', count: sessions.size });
}

function hostEvents(app: App, local: LocalHost): HostEvents {
  const live = <T extends unknown[]>(handle: (...values: T) => void) => (...values: T) => {
    if (!local.alive) return;
    try { handle(...values); } catch (error) { console.error('Host event failed:', error); }
  };
  return {
    runtimeEvent: live((runtimeId: string, event: any) => runtimeEvent(app, local, runtimeId, event)),
    stderr: live((runtimeId: string, line: string) => app.emit('pi://stderr', { type: 'stderr', runtimeId, line }, app.pi.owner(runtimeId))),
    sessionState: live((report: SessionStateReport) => sessionState(app, local, report)),
    sessionClosed: live((report: SessionClosedReport) => sessionClosed(app, local, report)),
    sessionRemoved: live((sessionId: string, sessionPath: string | null) => app.emit('pi://session-removed', { hostId: 'local', sessionId, sessionPath })),
    sessionsChanged: live(() => app.emit('pi://sessions-changed', null)),
    providerAuthChanged: live((flow: unknown) => {
      app.emit('pi://provider-auth-changed', { hostId: 'local', flow: flow ?? null });
      void app.usage.refresh(app, undefined, true);
    }),
    fastModelsChanged: live(() => app.emit('pi://fast-models-changed', { hostId: 'local' })),
    agentDefinitionsChanged: live(() => app.emit('pi://agent-definitions-changed', { hostId: 'local' })),
    diagnostic: live((line: string) => app.emit('pi://daemon-error', { hostId: 'local', line })),
  };
}

function runtimeEvent(app: App, local: LocalHost, runtimeId: string, event: any): void {
  const agent = app.pi.activeAgents.get(runtimeId);
  if (agent) {
    switch (event?.type) {
      case 'agent_start': app.pi.activeAgents.update(agent, { working: true }); break;
      case 'agent_settled': app.pi.activeAgents.update(agent, { working: false }); break;
      case 'ownership_lost': app.pi.activeAgents.update(agent, { working: false, messageable: true }); break;
      case 'ownership_acquired': app.pi.activeAgents.update(agent, { messageable: false }); break;
    }
  }
  // A runtime's events go only to the client that started it.
  const owner = app.pi.owner(runtimeId);
  if (event?.type === 'disconnected') {
    if (!app.pi.disconnectProcess(runtimeId, local)) return;
    app.pi.activeAgents.delete(runtimeId);
  }
  app.emit('pi://event', { runtimeId, event: event ?? null }, owner);
}

function sessionState(app: App, local: LocalHost, report: SessionStateReport): void {
  const state = report.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  const key = local.agentPrefix + report.sessionKey;
  const sessionId = typeof state.sessionId === 'string' ? state.sessionId : undefined;
  const sessionPath = typeof state.sessionFile === 'string' ? state.sessionFile : undefined;
  const previous = app.pi.activeAgents.get(key);
  // A turn that starts or ends changes the chat's row in the list: its time, preview and cost. The running mark of the
  // row changes at once on its own event (see ActiveAgents).
  const listChanged = !previous || previous.working !== report.working || previous.sessionId !== sessionId || previous.sessionPath !== sessionPath;
  if (sessionId !== undefined) {
    for (const agent of app.pi.activeAgents.values()) if (agent.hostId === 'local' && agent.sessionId === sessionId && agent.working !== report.working) app.pi.activeAgents.update(agent, { working: report.working });
  }
  local.sessionEpochs.set(key, report.epoch);
  app.pi.activeAgents.set(key, { hostId: 'local', sessionId, sessionPath, working: report.working, messageable: report.messageable });
  updateSettingsPending(app, key, report.settingsPending);
  if (listChanged) app.emit('pi://sessions-changed', null);
}

function sessionClosed(app: App, local: LocalHost, report: SessionClosedReport): void {
  const key = local.agentPrefix + report.sessionKey;
  if (local.sessionEpochs.get(key) !== report.epoch) return;
  local.sessionEpochs.delete(key);
  app.pi.activeAgents.delete(key);
  updateSettingsPending(app, key, false);
  app.emit('pi://sessions-changed', null);
}
