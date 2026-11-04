import { join } from "node:path";
import { reserve, releaseReservation } from "./session_registry";
import { STORAGE_DIRECTORY, BROKER_QUEUE_DEPTH, BROKER_WORKERS } from './config';
import { buildPiCommand, launchSpec } from './pi_launch';
import { homeDir } from './environment';
import { loadAppSettings } from './settings';
import * as peers from './peers';
import * as providerAuth from './provider_auth';
import * as daemonRestart from './daemon_restart';
import { localHost } from './local_host';
import type { OrchestrationRequest } from './host/index';
import * as sessionGroups from './session_groups';
import type { App } from './app';
import type { AgentAddress, SessionSummary } from './types';
import { logFailure } from './util/sync';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value.trim().replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1')); }

export function agentIsActive(session: SessionSummary, agent: AgentAddress): boolean {
  return !agent.messageable && agent.hostId === session.hostId && (agent.sessionId === session.id || agent.sessionPath === session.path);
}

export class BusyAgent {
  private released = false;
  constructor(private key: string, private busy: Set<string>) {}
  release(): void { if (this.released) return; this.released = true; this.busy.delete(this.key); }
}

export class BrokerRuntime {
  closing = false;
  messageCount = 0;
  deliveries = new Map<string, number>();
  busy = new Set<string>();
  active = 0;

  ensureIdle(): void {
    if (this.messageCount > 0 || this.deliveries.size > 0) throw new Error('Wait for active broker requests to finish before restarting the daemon');
  }

  shutdown(): void { this.closing = true; }
}

export function claimAgent(broker: BrokerRuntime, sessionId: string): BusyAgent {
  if (broker.busy.has(sessionId)) throw new Error(`Agent ${sessionId} is already responding`);
  broker.busy.add(sessionId);
  return new BusyAgent(sessionId, broker.busy);
}

export class BrokerBusyError extends Error {}

export type BrokerAnswer = { data: unknown } | { error: string; transient: boolean };

export type BrokerCall = (source: string, request: Record<string, unknown>) => Promise<BrokerAnswer>;

async function withBrokerAccess<T>(app: App, work: () => Promise<T>): Promise<T> {
  const release = app.restart.gate.tryRead();
  if (!release) throw new Error('The daemon is preparing a restart');
  try {
    if ((await daemonRestart.blocking()) || app.clients.closing()) throw new Error('The daemon is restarting or shutting down. Reconnect before retrying.');
    return await work();
  } finally { release(); }
}

export async function piBrokerRequest(app: App, broker: BrokerRuntime, source: string, request: Record<string, unknown>): Promise<BrokerAnswer> {
  try {
    const { path, body } = request;
    if (typeof path !== 'string') throw new Error('Broker request has no path');
    if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new Error('Broker request body must be an object');
    return { data: await brokerRequest(app, broker, path, { ...body, ...senderFields(path, source) }) ?? null };
  } catch (error: any) {
    return { error: error?.message ?? String(error), transient: error instanceof BrokerBusyError };
  }
}

function senderFields(path: string, source: string): Record<string, string> {
  if (path === '/orchestration') return { sourceSessionId: source, sourceHostId: 'local' };
  if (path === '/peer-project') return { sessionId: source };
  return {};
}

export function clientBrokerRequest(app: App, path: string, body: any): Promise<any> {
  if (path !== '/orchestration' || (typeof body?.hostId === 'string' && body.hostId !== 'local')) {
    return Promise.reject(new Error('Peer broker requests must target this host'));
  }
  return brokerRequest(app, app.broker, path, body);
}

async function brokerRequest(app: App, broker: BrokerRuntime, path: string, body: any): Promise<any> {
  if (broker.closing || broker.active >= BROKER_WORKERS + BROKER_QUEUE_DEPTH) throw new BrokerBusyError('Session broker is busy');
  broker.active += 1;
  try {
    if (path === '/orchestration') return await enqueueOrchestration(app, broker, body);
    return await withBrokerAccess(app, () => respondBrokerRequest(app, broker, path, body));
  } finally { broker.active -= 1; }
}

function registerDelivery(broker: BrokerRuntime, value: any): (() => void) | undefined {
  if (value?.action !== 'send') return undefined;
  if (typeof value.hostId !== 'string') throw new Error('hostId is required');
  if (typeof value.sessionId !== 'string') throw new Error('sessionId is required');
  const key = `${value.hostId}\0${value.sessionId}`;
  broker.deliveries.set(key, (broker.deliveries.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    const count = broker.deliveries.get(key);
    if (count === undefined) return;
    if (count <= 1) broker.deliveries.delete(key); else broker.deliveries.set(key, count - 1);
  };
}

async function enqueueOrchestration(app: App, broker: BrokerRuntime, value: any): Promise<any> {
  const worker = value?.action === 'send' || value?.action === 'branch_off';
  if (worker && broker.messageCount >= BROKER_WORKERS) throw new BrokerBusyError('Session broker is busy');
  const delivery = registerDelivery(broker, value);
  if (worker) broker.messageCount += 1;
  try {
    return await withBrokerAccess(app, () => brokerOrchestration(app, broker, value));
  } finally {
    if (worker) broker.messageCount = Math.max(0, broker.messageCount - 1);
    delivery?.();
  }
}

async function respondBrokerRequest(app: App, broker: BrokerRuntime, path: string, value: any): Promise<any> {
  if (path === '/session-identity') {
    const root = join(homeDir(), STORAGE_DIRECTORY);
    if (value?.action === 'reserve' && Number.isInteger(value.count) && value.count >= 1 && value.count <= 2) {
      return { sessionIds: Array.from({ length: value.count }, () => reserve(root)) };
    }
    if (value?.action === 'release' && Array.isArray(value.sessionIds) && value.sessionIds.length <= 2 && value.sessionIds.every(isUuid)) {
      for (const id of value.sessionIds) releaseReservation(root, id);
      return null;
    }
    throw new Error('Invalid session identity request');
  }
  if (path === '/peer-project') {
    if (typeof value?.name !== 'string' || !isUuid(value.sessionId) || typeof value.cwd !== 'string') throw new Error('Invalid peer project request');
    return { cwd: await sessionGroups.peerProjectFolder(value.name, 'local:' + value.sessionId, value.cwd) };
  }
  if (path === '/fast-models') return providerAuth.forOwner(app, 'fast-models', { action: 'fast_models' });
  if (path === '/agents') return brokerAgents(app, broker);
  throw new Error('Unknown session broker endpoint');
}

async function brokerAgents(app: App, broker: BrokerRuntime): Promise<any> {
  const active = [...app.pi.activeAgents.values()];
  const busy = new Set(broker.busy);
  const sessions = await peers.localSummaries(app, app.sessionIndex);
  return sessions.filter(session => session.auxiliaryParentId === undefined).map(session => ({
    hostId: session.hostId, sessionId: session.id, name: session.name, project: session.project, cwd: session.cwd,
    active: (session.hostId === 'local' && busy.has(session.id)) || active.some(agent => agentIsActive(session, agent)),
  }));
}

async function brokerOrchestration(app: App, broker: BrokerRuntime, value: any): Promise<any> {
  const host = value?.hostId;
  if (typeof host !== 'string') throw new Error('hostId is required');
  if (host !== 'local') {
    const result = await peers.forwardBroker(app, host, '/orchestration', value);
    return brokerInterruptionStatus(broker, value, result);
  }
  const [id, action] = orchestrationTarget(value);
  if (action === 'branch_off') return brokerBranchOff(app, value, id);
  if (action === 'settle_first_message') return brokerSettleFirstMessage(app, value, id);
  if (action === 'interrupt' || action === 'locate' || action === 'read' || action === 'watch' || action === 'preview' || action === 'rename') {
    const result = await localHost(app).host.orchestrate({ action, sessionKey: id, deliveryId: value.deliveryId ?? null, stateKey: value.stateKey ?? null, waitMs: value.waitMs ?? null, name: value.name ?? null } as OrchestrationRequest);
    return brokerInterruptionStatus(broker, value, result);
  }
  return brokerConversationOperation(app, value, id, action);
}

async function brokerBranchOff(app: App, value: any, id: string): Promise<{ peerId: string }> {
  const created = await localHost(app).host.orchestrate({ action: 'branch_off', sessionKey: id });
  const peerId = created?.sessionId;
  if (!isUuid(peerId) || typeof created?.sessionPath !== 'string') throw new Error('Branch-off returned no peer');
  try { await brokerConversationOperation(app, { ...value, discardOnFailure: true }, peerId, 'send'); }
  catch (error: any) {
    const reason = error?.message ?? String(error);
    let arrived: boolean;
    try { arrived = (await brokerSettleFirstMessage(app, { ...value, sessionPath: created.sessionPath }, peerId)).arrived; }
    catch (settle: any) { throw new Error(`The first message of peer ${peerId} failed, and Piop could not settle it: ${reason}; ${settle?.message ?? settle}`); }
    if (!arrived) throw new Error(`The peer was not created: ${reason}`);
  }
  return { peerId };
}

async function brokerSettleFirstMessage(app: App, value: any, id: string): Promise<{ arrived: boolean }> {
  if (typeof value.sessionPath !== 'string') throw new Error('sessionPath is required');
  const settings = await loadAppSettings(app);
  const host = localHost(app).host;
  const location = await host.orchestrate({ action: 'locate', sessionKey: id }).catch(error => { logFailure('Could not find chat ' + id + ' to settle its first message')(error); return null; });
  const request: OrchestrationRequest = { action: 'settle_first_message', sessionKey: id, sessionPath: value.sessionPath, deliveryId: value.deliveryId ?? null, clientId: value.clientId ?? null };
  if (typeof location?.cwd === 'string' && typeof location?.sessionPath === 'string') {
    request.spec = launchSpec(buildPiCommand(settings, { kind: 'rpc', cwd: location.cwd, sessionPath: location.sessionPath }));
    request.cwd = location.cwd;
  }
  return { arrived: (await host.orchestrate(request))?.arrived === true };
}

async function brokerConversationOperation(app: App, value: any, id: string, action: string): Promise<any> {
  const settings = await loadAppSettings(app);
  const local = localHost(app).host;
  const location = await local.orchestrate({ action: 'locate', sessionKey: id });
  if (location?.archived === true) throw new Error('This conversation is archived. Restore it before sending another task');
  const path = location?.sessionPath;
  if (typeof path !== 'string') throw new Error('Conversation lookup returned no saved path');
  const cwd = location?.cwd;
  if (typeof cwd !== 'string') throw new Error('Conversation lookup returned no working directory');
  const field = (key: string) => value[key] ?? null;
  const request: OrchestrationRequest = { action: action as 'send', sessionKey: id, sessionPath: path,
    sourceSessionId: field('sourceSessionId'), sourceHostId: field('sourceHostId'), sourceName: field('sourceName'), message: field('message'), wake: field('wake'), clientId: field('clientId'),
    deliveryId: field('deliveryId'), discardOnFailure: field('discardOnFailure'), deliverAs: field('deliverAs') };
  if (action === 'send') {
    request.spec = launchSpec(buildPiCommand(settings, { kind: 'rpc', cwd, sessionPath: path }));
    request.cwd = cwd;
  }
  return local.orchestrate(request);
}

function brokerInterruptionStatus(broker: BrokerRuntime, request: any, result: any): any {
  if (request?.action === 'interrupt') {
    if (typeof request.hostId !== 'string') throw new Error('hostId is required');
    if (typeof request.sessionId !== 'string') throw new Error('sessionId is required');
    if (broker.deliveries.has(`${request.hostId}\0${request.sessionId}`)) {
      if (result && typeof result === 'object' && !Array.isArray(result)) result.completed = false;
      else result = { completed: false };
    }
  }
  return result;
}

function orchestrationTarget(value: any): [string, string] {
  if (typeof value?.sessionId !== 'string') throw new Error('sessionId is required');
  if (typeof value?.action !== 'string') throw new Error('action is required');
  if (!['read', 'send', 'interrupt', 'locate', 'watch', 'preview', 'rename', 'branch_off', 'settle_first_message'].includes(value.action)) throw new Error('Unknown orchestration action');
  return [value.sessionId, value.action];
}
