import { join } from "node:path";
import { reserve, releaseReservation } from "./session_registry";
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { STORAGE_DIRECTORY, BROKER_BODY_BYTES, BROKER_HEADER_BYTES, BROKER_QUEUE_DEPTH, BROKER_WORKERS } from './config';
import { buildPiCommand, launchSpec } from './pi_launch';
import { homeDir } from './environment';
import { loadAppSettings } from './settings';
import { collectSessions } from './session_index';
import * as peers from './peers';
import * as providerAuth from './provider_auth';
import * as daemonRestart from './daemon_restart';
import * as daemon from './daemon';
import * as sessionGroups from './session_groups';
import type { App } from './app';
import type { AgentAddress, SessionSummary } from './types';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value.trim().replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1')); }

export function agentIsActive(session: SessionSummary, agent: AgentAddress): boolean {
  return !agent.messageable && agent.hostId === session.hostId && (agent.sessionId === session.id || agent.sessionPath === session.path);
}

/** A claim that marks an agent as busy until released. */
export class BusyAgent {
  private released = false;
  constructor(private key: string, private busy: Set<string>) {}
  release(): void { if (this.released) return; this.released = true; this.busy.delete(this.key); }
}

export class BrokerRuntime {
  closing = false;
  messageCount = 0;
  deliveries = new Map<string, number>();
  port = 0;
  token = randomUUID();
  busy = new Set<string>();
  active = 0;

  ensureIdle(): void {
    if (this.messageCount > 0 || this.deliveries.size > 0) throw new Error('Wait for active broker requests to finish before restarting the daemon');
  }

  shutdown(): void { this.closing = true; }
}

export function brokerEnvironment(broker: BrokerRuntime): [number, string] {
  if (broker.port === 0) throw new Error('Session broker is not ready');
  return [broker.port, broker.token];
}

export function claimAgent(broker: BrokerRuntime, hostId: string, sessionId: string): BusyAgent {
  const key = `${hostId}\0${sessionId}`;
  if (broker.busy.has(key)) throw new Error(`Agent ${hostId}/${sessionId} is already responding`);
  broker.busy.add(key);
  return new BusyAgent(key, broker.busy);
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' });
  response.end(payload);
}

async function finish(response: ServerResponse, operation: () => Promise<any>): Promise<void> {
  try { respond(response, 200, { data: await operation() }); }
  catch (error: any) { respond(response, 400, { error: error?.message ?? String(error) }); }
}

async function withBrokerAccess<T>(app: App, work: () => Promise<T>): Promise<T> {
  const release = app.restart.gate.tryRead();
  if (!release) throw new Error('The daemon is preparing a restart');
  try {
    if ((await daemonRestart.blocking()) || app.clients.closing()) throw new Error('The daemon is restarting or shutting down. Reconnect before retrying.');
    return await work();
  } finally { release(); }
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0;
    request.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) { reject(new Error('Message is too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJson(body: Buffer, message: string): any {
  try { return JSON.parse(body.toString('utf8')); } catch { throw new Error(message); }
}

export async function startSessionBroker(app: App, broker: BrokerRuntime): Promise<void> {
  const server = createServer({ maxHeaderSize: BROKER_HEADER_BYTES, requestTimeout: 5000, headersTimeout: 5000, keepAlive: false }, (request, response) => {
    void handleRequest(app, broker, request, response).catch(() => { try { response.destroy(); } catch {} });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => reject(new Error(`Could not start session broker: ${error.message}`)));
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  broker.port = typeof address === 'object' && address ? address.port : 0;
}

async function handleRequest(app: App, broker: BrokerRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? '';
  const path = request.url ?? '';
  if (request.headers.authorization?.trim() !== `Bearer ${broker.token}`) { respond(response, 401, { error: 'Unauthorized' }); return; }
  const contentLength = Number.parseInt(String(request.headers['content-length'] ?? '0'), 10) || 0;
  if (contentLength > BROKER_BODY_BYTES) { respond(response, 413, { error: 'Message is too large' }); return; }
  if (broker.active >= BROKER_WORKERS + BROKER_QUEUE_DEPTH) { respond(response, 503, { error: 'Session broker is busy' }); return; }
  broker.active += 1;
  try {
    const body = await readBody(request, BROKER_BODY_BYTES);
    if (method === 'POST' && path === '/orchestration') { await enqueueOrchestration(app, broker, response, body); return; }
    await finish(response, () => withBrokerAccess(app, () => respondBrokerRequest(app, broker, method, path, body)));
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

async function enqueueOrchestration(app: App, broker: BrokerRuntime, response: ServerResponse, body: Buffer): Promise<void> {
  let delivery: (() => void) | undefined;
  let value: any;
  try {
    value = parseJson(body, 'Invalid orchestration request');
    delivery = registerDelivery(broker, value);
  }
  catch (error: any) { respond(response, 400, { error: error.message }); return; }
  // Only turns that run an agent take a worker slot. Interrupt, read and locate must still get through when every worker is busy.
  const worker = value?.action === 'send' || value?.action === 'branch_off';
  if ((worker && broker.messageCount >= BROKER_WORKERS) || broker.closing) { delivery?.(); respond(response, 503, { error: 'Session broker is busy' }); return; }
  if (worker) broker.messageCount += 1;
  try {
    await finish(response, () => withBrokerAccess(app, () => brokerOrchestration(app, broker, value)));
  } finally {
    if (worker) broker.messageCount = Math.max(0, broker.messageCount - 1);
    delivery?.();
  }
}

async function respondBrokerRequest(app: App, broker: BrokerRuntime, method: string, path: string, body: Buffer): Promise<any> {
  if (method === 'POST' && path === '/session-identity') {
    const value = parseJson(body, 'Invalid session identity request');
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
  if (method === 'POST' && path === '/peer-project') {
    const value = parseJson(body, 'Invalid peer project request');
    if (typeof value?.name !== 'string' || !isUuid(value.sessionId) || typeof value.cwd !== 'string') throw new Error('Invalid peer project request');
    return { cwd: await sessionGroups.peerProjectFolder(value.name, 'local:' + value.sessionId, value.cwd) };
  }
  if (method === 'POST' && path === '/fast-models') {
    const value = parseJson(body, 'Invalid fast model request');
    if (typeof value?.hostId !== 'string') throw new Error('hostId is required');
    return providerAuth.forOwner(app, 'fast-models', value.hostId, { action: 'fast_models' });
  }
  if (method === 'GET' && path === '/agents') return brokerAgents(app, broker);
  throw new Error('Unknown session broker endpoint');
}

async function brokerAgents(app: App, broker: BrokerRuntime): Promise<any> {
  const active = [...app.pi.activeAgents.values()];
  const busy = new Set(broker.busy);
  const sessions = await collectSessions(app, app.sessionIndex, true);
  return sessions.filter(session => session.subagentParentId === undefined).map(session => ({
    hostId: session.hostId, sessionId: session.id, name: session.name, project: session.project, cwd: session.cwd,
    active: busy.has(`${session.hostId}\0${session.id}`) || active.some(agent => agentIsActive(session, agent)),
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
  if (action === 'branch_off') return brokerBranchOff(app, broker, value, host, id);
  if (action === 'settle_first_message') return brokerSettleFirstMessage(app, broker, value, host, id);
  if (action === 'interrupt' || action === 'locate' || action === 'read' || action === 'watch') {
    const settings = await loadAppSettings(app);
    const connection = await daemon.connect(app, app.pi, broker, settings, host);
    const result = await connection.request({ type: 'orchestration', action, sessionKey: id, deliveryId: value.deliveryId ?? null, stateKey: value.stateKey ?? null, waitMs: value.waitMs ?? null });
    return brokerInterruptionStatus(broker, value, result);
  }
  return brokerConversationOperation(app, broker, value, host, id, action);
}

/**
 * Branches the conversation id off into a new peer in its own worktree and sends the peer its first message.
 * All or nothing: when the message does not arrive, the peer, its worktree and its branch are removed.
 */
async function brokerBranchOff(app: App, broker: BrokerRuntime, value: any, host: string, id: string): Promise<{ peerId: string }> {
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, broker, settings, host);
  const created = await connection.request({ type: 'orchestration', action: 'branch_off', sessionKey: id });
  const peerId = created?.sessionId;
  if (!isUuid(peerId) || typeof created?.sessionPath !== 'string') throw new Error('Branch-off returned no peer');
  try { await brokerConversationOperation(app, broker, { ...value, discardOnFailure: true }, host, peerId, 'send'); }
  catch (error: any) {
    const reason = error?.message ?? String(error);
    let arrived: boolean;
    try { arrived = (await brokerSettleFirstMessage(app, broker, { ...value, sessionPath: created.sessionPath }, host, peerId)).arrived; }
    catch (settle: any) { throw new Error(`The first message of peer ${peerId} failed, and Piop could not settle it: ${reason}; ${settle?.message ?? settle}`); }
    if (!arrived) throw new Error(`The peer was not created: ${reason}`);
  }
  return { peerId };
}

/**
 * Settles the first message of a new chat whose sender lost the answer: the chat is kept when the message arrived and
 * removed otherwise. A chat that has no location any more was already removed.
 */
async function brokerSettleFirstMessage(app: App, broker: BrokerRuntime, value: any, host: string, id: string): Promise<{ arrived: boolean }> {
  if (typeof value.sessionPath !== 'string') throw new Error('sessionPath is required');
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, broker, settings, host);
  const location = await connection.request({ type: 'orchestration', action: 'locate', sessionKey: id }).catch(() => null);
  const packet: any = { type: 'orchestration', action: 'settle_first_message', sessionKey: id, sessionPath: value.sessionPath, deliveryId: value.deliveryId ?? null, clientId: value.clientId ?? null };
  if (typeof location?.cwd === 'string' && typeof location?.sessionPath === 'string') {
    packet.spec = launchSpec(buildPiCommand(broker, settings, host, { kind: 'rpc', cwd: location.cwd, sessionPath: location.sessionPath }, connection.remotePort));
    packet.cwd = location.cwd;
  }
  return { arrived: (await connection.request(packet))?.arrived === true };
}

async function brokerConversationOperation(app: App, broker: BrokerRuntime, value: any, host: string, id: string, action: string): Promise<any> {
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, broker, settings, host);
  const location = await connection.request({ type: 'orchestration', action: 'locate', sessionKey: id });
  if (location?.archived === true) throw new Error('This conversation is archived. Restore it before sending another task');
  const path = location?.sessionPath;
  if (typeof path !== 'string') throw new Error('Conversation lookup returned no saved path');
  const cwd = location?.cwd;
  if (typeof cwd !== 'string') throw new Error('Conversation lookup returned no working directory');
  const field = (key: string) => value[key] ?? null;
  const packet: any = { type: 'orchestration', action, sessionKey: id, sessionPath: path,
    sourceSessionId: field('sourceSessionId'), sourceHostId: field('sourceHostId'), sourceName: field('sourceName'), message: field('message'), wake: field('wake'), clientId: field('clientId'),
    deliveryId: field('deliveryId'), discardOnFailure: field('discardOnFailure'), deliverAs: field('deliverAs') };
  if (action === 'send') {
    const command = buildPiCommand(broker, settings, host, { kind: 'rpc', cwd, sessionPath: path }, connection.remotePort);
    packet.spec = launchSpec(command);
    packet.cwd = cwd;
  }
  return connection.request(packet);
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
  if (!['read', 'send', 'interrupt', 'locate', 'watch', 'branch_off', 'settle_first_message'].includes(value.action)) throw new Error('Unknown orchestration action');
  return [value.sessionId, value.action];
}
