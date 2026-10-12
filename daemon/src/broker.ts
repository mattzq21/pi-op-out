import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BROKER_BODY_BYTES, BROKER_HEADER_BYTES, BROKER_QUEUE_DEPTH, BROKER_WORKERS, MAX_AGENT_OUTPUT_BYTES } from './config';
import { MessageOutput, recover as recoverOutput } from './broker_output';
import { buildPiCommand, launchSpec, type LaunchCommand } from './pi_launch';
import { ensureDesktopSessionsDir, shellQuote, spawnOptions } from './process_io';
import { stopMessageWorker } from './process_cleanup';
import { homeDir } from './environment';
import { loadAppSettings } from './settings';
import { collectSessions, listLocalSessions } from './session_index';
import * as conversationOwnership from './conversation_ownership';
import * as peers from './peers';
import * as terminalLookup from './terminal_lookup';
import * as providerAuth from './provider_auth';
import * as daemonRestart from './daemon_restart';
import * as daemon from './daemon';
import type { App } from './app';
import type { AppSettings } from './settings_types';
import type { AgentAddress, SessionSummary } from './types';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value.trim().replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1')); }

function nonBlank(value: unknown): value is string { return typeof value === 'string' && value.trim() !== ''; }

export function resolveAgent(sessions: SessionSummary[], hostId: string, sessionId: string): SessionSummary {
  const session = sessions.find(session => session.hostId === hostId && session.id === sessionId);
  if (!session) throw new Error(`Agent ${hostId}/${sessionId} was not found`);
  return session;
}

export function agentIsActive(session: SessionSummary, agent: AgentAddress): boolean {
  return !agent.messageable && agent.hostId === session.hostId && (agent.sessionId === session.id || agent.sessionPath === session.path);
}

interface MessageJob { child: ChildProcess; output: MessageOutput }

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
  jobs = new Map<string, MessageJob>();
  /** Request IDs whose message job is between its checks and its registration in jobs. */
  starting = new Set<string>();
  cancelled = new Set<string>();
  active = 0;

  ensureIdle(): void {
    if (this.messageCount > 0 || this.jobs.size > 0 || this.starting.size > 0 || this.deliveries.size > 0) throw new Error('Wait for active broker requests to finish before restarting the daemon');
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    await Promise.all(jobs.map(async job => { await stopMessageWorker(job.child); job.output.remove(); }));
  }

  withUncancelledRequest<T>(id: string, register: () => T): T {
    if (this.cancelled.delete(id)) throw new Error('Agent message was cancelled');
    return register();
  }
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
  await recoverOutput();
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
    if (method === 'POST' && (path === '/message' || path === '/orchestration')) { await enqueueBrokerMessage(app, broker, response, body, path === '/orchestration'); return; }
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

async function enqueueBrokerMessage(app: App, broker: BrokerRuntime, response: ServerResponse, body: Buffer, orchestration: boolean): Promise<void> {
  let delivery: (() => void) | undefined;
  let value: any;
  try {
    value = parseJson(body, orchestration ? 'Invalid orchestration request' : 'Invalid message request');
    delivery = orchestration ? registerDelivery(broker, value) : undefined;
  }
  catch (error: any) { respond(response, 400, { error: error.message }); return; }
  // Only turns that run an agent take a worker slot. Interrupt, read and locate must still get through when every worker is busy.
  const worker = !orchestration || value?.action === 'send' || value?.action === 'recover_usage';
  if ((worker && broker.messageCount >= BROKER_WORKERS) || broker.closing) { delivery?.(); respond(response, 503, { error: 'Session broker is busy' }); return; }
  if (worker) broker.messageCount += 1;
  try {
    await finish(response, () => withBrokerAccess(app, async () => orchestration
      ? brokerOrchestration(app, broker, value)
      : processBrokerMessage(app, broker, body)));
  } finally {
    if (worker) broker.messageCount = Math.max(0, broker.messageCount - 1);
    delivery?.();
  }
}

async function brokerTerminalLookup(app: App, body: Buffer): Promise<any> {
  const value = parseJson(body, 'Invalid terminal lookup request');
  const hostId = value?.hostId;
  if (typeof hostId !== 'string') throw new Error('hostId is required');
  if (hostId !== 'local') return peers.forwardBroker(app, hostId, '/terminals', value);
  return terminalLookup.lookup(app.terminals, value, hostId);
}

async function respondBrokerRequest(app: App, broker: BrokerRuntime, method: string, path: string, body: Buffer): Promise<any> {
  if (method === 'GET' && path === '/agent-definitions') {
    const connection = app.pi.connections.get('local');
    if (!connection) throw new Error('Agent definitions are unavailable');
    return connection.request({ type: 'agent_definitions' });
  }
  if (method === 'POST' && path === '/fast-capabilities') {
    const value = parseJson(body, 'Invalid Fast mode capability request');
    if (typeof value?.hostId !== 'string') throw new Error('hostId is required');
    return providerAuth.forOwner(app, 'fast-mode-discovery', value.hostId, { action: 'fast_capabilities' });
  }
  if (method === 'POST' && path === '/terminals') return brokerTerminalLookup(app, body);
  if (method === 'GET' && path === '/agents') return brokerAgents(app, broker);
  if (method === 'POST' && path === '/cancel') {
    const value = parseJson(body, 'Invalid cancellation request');
    const requestId = value?.requestId;
    if (!isUuid(requestId)) throw new Error('requestId is required');
    // Cancellations for requests that never start a job would stay forever; drop the oldest instead of every entry.
    while (broker.cancelled.size >= BROKER_QUEUE_DEPTH * 2) { const oldest = broker.cancelled.values().next().value; if (oldest === undefined) break; broker.cancelled.delete(oldest); }
    broker.cancelled.add(requestId);
    await peers.cancelMessage(app, requestId);
    const job = broker.jobs.get(requestId);
    if (job) await stopMessageWorker(job.child);
    return { cancelled: true };
  }
  throw new Error('Unknown session broker endpoint');
}

async function messageContext(app: App, broker: BrokerRuntime, session: SessionSummary, clientId: string): Promise<{ settings: AppSettings; claim: BusyAgent; ownership: conversationOwnership.MutationGuard }> {
  const claim = claimAgent(broker, session.hostId, session.id);
  let ownership: conversationOwnership.MutationGuard | undefined;
  try {
    ownership = await conversationOwnership.MutationGuard.acquire(app, session.hostId, session.path, clientId, false, 'message');
    const settings = await loadAppSettings(app);
    const connection = app.pi.connections.get(session.hostId);
    if (connection?.alive) await connection.request({ type: 'retire', sessionKey: session.id, sessionPath: session.path });
    return { settings, claim, ownership };
  } catch (error) { ownership?.release(); claim.release(); throw error; }
}

function messageCommand(broker: BrokerRuntime, settings: AppSettings, session: SessionSummary, clientId: string): LaunchCommand {
  const command = buildPiCommand(broker, settings, session.hostId, { kind: 'print', cwd: session.cwd, sessionPath: session.path });
  if (session.hostId !== 'local') {
    const last = command.args.length - 1;
    if (last < 0) throw new Error('Missing remote agent command');
    command.args[last] = `export PIOP_CONVERSATION_CLIENT=${shellQuote(clientId)}; ${command.args[last]}`;
  }
  command.env.PIOP_CONVERSATION_CLIENT = clientId;
  return command;
}

async function startMessageJob(command: LaunchCommand, broker: BrokerRuntime, requestId: string, deadline: number): Promise<MessageJob> {
  if (broker.closing) throw new Error('App is closing');
  if (broker.jobs.has(requestId) || broker.starting.has(requestId)) throw new Error('Agent message request is already running');
  if (Date.now() >= deadline) throw new Error('Agent message expired');
  if (broker.cancelled.delete(requestId)) throw new Error('Agent message was cancelled');
  broker.starting.add(requestId);
  try {
    const output = await MessageOutput.prepare();
    if (broker.closing) { output.remove(); throw new Error('App is closing'); }
    if (broker.cancelled.delete(requestId)) { output.remove(); throw new Error('Agent message was cancelled'); }
    let child: ChildProcess;
    try {
      child = spawn(command.program, command.args, spawnOptions(command, { stdio: output.stdio(), detached: true }));
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } catch (error: any) { output.remove(); throw new Error(`Could not message agent: ${error.message ?? error}`); }
    output.closeOutputs();
    child.on('error', () => {});
    // A cancellation or shutdown during the spawn found no job to stop. The worker has no message yet, so stop it here.
    const stopped = broker.closing ? 'App is closing' : broker.cancelled.delete(requestId) ? 'Agent message was cancelled' : undefined;
    if (stopped) { await stopMessageWorker(child); output.remove(); throw new Error(stopped); }
    const job = { child, output };
    broker.jobs.set(requestId, job);
    return job;
  } finally { broker.starting.delete(requestId); }
}

function fileSize(path: string): number { try { return statSync(path).size; } catch { return 0; } }

function messageLimitError(output: MessageOutput, deadline: number): string | undefined {
  if (fileSize(output.stdout) + fileSize(output.stderr) > MAX_AGENT_OUTPUT_BYTES) return 'Agent output exceeded the 16 MiB limit';
  if (Date.now() >= deadline) return 'Agent message exceeded its deadline';
  return undefined;
}

async function waitMessage(broker: BrokerRuntime, requestId: string, job: MessageJob, deadline: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exited = () => job.child.exitCode !== null || job.child.signalCode !== null;
  const status = () => ({ code: job.child.exitCode, signal: job.child.signalCode });
  if (exited()) return status();
  // The exit event ends the wait. Cancellation, shutdown and the output limit have no event, so they are checked on a slow timer.
  const reason = await new Promise<string | undefined>(resolve => {
    const timer = setInterval(() => {
      if (broker.closing) finish('App is closing');
      else if (broker.cancelled.has(requestId)) finish('Agent message was cancelled');
      else { const error = messageLimitError(job.output, deadline); if (error) finish(error); }
    }, 250);
    const onExit = () => finish(undefined);
    const finish = (value: string | undefined) => { clearInterval(timer); job.child.off('exit', onExit); resolve(value); };
    job.child.once('exit', onExit);
  });
  if (reason !== undefined) { await stopMessageWorker(job.child); throw new Error(reason); }
  return status();
}

function messageResult(output: MessageOutput, status: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (fileSize(output.stdout) + fileSize(output.stderr) > MAX_AGENT_OUTPUT_BYTES) throw new Error('Agent output exceeded the 16 MiB limit');
  let stdout: Buffer; let stderr: Buffer;
  try { stdout = readFileSync(output.stdout); } catch (error: any) { throw new Error(`Could not read agent output: ${error.message}`); }
  try { stderr = readFileSync(output.stderr); } catch (error: any) { throw new Error(`Could not read agent errors: ${error.message}`); }
  if (status.code !== 0) {
    const detail = stderr.toString('utf8').trim().split('\n').slice(-20).join('\n');
    const exit = status.code !== null ? `exit status ${status.code}` : `signal ${status.signal}`;
    throw new Error(detail ? `Agent failed (${exit}): ${detail}` : `Agent failed with ${exit} and no error output`);
  }
  return stdout.toString('utf8').trim();
}

function messageDeadline(broker: BrokerRuntime, deadlineMs: number): number {
  const remaining = Math.max(0, deadlineMs - Date.now());
  if (remaining === 0 || broker.closing) throw new Error('Agent message expired or app is closing');
  return Date.now() + Math.min(remaining, 600_000);
}

async function dispatchAgentMessage(app: App, broker: BrokerRuntime, session: SessionSummary, message: string, requestId: string, deadlineMs: number, clientId: string): Promise<string> {
  const deadline = messageDeadline(broker, deadlineMs);
  const { settings, claim, ownership } = await messageContext(app, broker, session, clientId);
  try {
    if (Date.now() >= deadline) throw new Error('Agent message expired');
    const command = messageCommand(broker, settings, session, clientId);
    const job = await startMessageJob(command, broker, requestId, deadline);
    try {
      job.child.stdin?.on('error', () => {});
      job.child.stdin?.end(message);
      const status = await waitMessage(broker, requestId, job, deadline);
      return messageResult(job.output, status);
    } finally {
      await stopMessageWorker(job.child);
      if (broker.jobs.get(requestId) === job) broker.jobs.delete(requestId);
      broker.cancelled.delete(requestId);
      job.output.remove();
    }
  } finally { ownership.release(); claim.release(); }
}

async function processBrokerMessage(app: App, broker: BrokerRuntime, body: Buffer): Promise<any> {
  const value = parseJson(body, 'Invalid message request');
  const requestId = value?.requestId;
  if (!isUuid(requestId)) throw new Error('requestId is required');
  if (!nonBlank(value.hostId)) throw new Error('hostId is required');
  if (!nonBlank(value.sessionId)) throw new Error('sessionId is required');
  if (!nonBlank(value.message)) throw new Error('message is required');
  const hostId: string = value.hostId;
  if (hostId !== 'local') return peers.forwardBroker(app, hostId, '/message', value);
  const sessions = await brokerMessageSessions(app, hostId);
  const session = resolveAgent(sessions, hostId, value.sessionId);
  const deadline = typeof value.deadline === 'number' && Number.isInteger(value.deadline) && value.deadline >= 0 ? value.deadline : Date.now() + 120_000;
  if (typeof value.clientId !== 'string') throw new Error('Conversation client is missing');
  const reply = await dispatchAgentMessage(app, broker, session, value.message, requestId, deadline, value.clientId);
  return { reply };
}

async function brokerAgents(app: App, broker: BrokerRuntime): Promise<any> {
  const active = [...app.pi.activeAgents.values()];
  const busy = new Set(broker.busy);
  const sessions = await collectSessions(app, app.sessionIndex);
  return sessions.filter(session => session.subagentParentId === undefined).map(session => ({
    hostId: session.hostId, sessionId: session.id, name: session.name, project: session.project, cwd: session.cwd,
    active: busy.has(`${session.hostId}\0${session.id}`) || active.some(agent => agentIsActive(session, agent)),
  }));
}

async function brokerMessageSessions(app: App, hostId: string): Promise<SessionSummary[]> {
  if (hostId === 'local') return listLocalSessions(app.sessionIndex, ensureDesktopSessionsDir(homeDir()));
  return collectSessions(app, app.sessionIndex);
}

async function brokerOrchestration(app: App, broker: BrokerRuntime, value: any): Promise<any> {
  const host = value?.hostId;
  if (typeof host !== 'string') throw new Error('hostId is required');
  if (host !== 'local') {
    const result = await peers.forwardBroker(app, host, '/orchestration', value);
    return brokerInterruptionStatus(broker, value, result);
  }
  const [id, action] = orchestrationTarget(value);
  if (action === 'interrupt' || action === 'locate' || action === 'read') {
    const settings = await loadAppSettings(app);
    const connection = await daemon.connect(app, app.pi, broker, settings, host);
    const result = await connection.request({ type: 'orchestration', action, sessionKey: id, deliveryId: value.deliveryId ?? null });
    return brokerInterruptionStatus(broker, value, result);
  }
  return brokerConversationOperation(app, broker, value, host, id, action);
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
    sourceSessionId: field('sourceSessionId'), sourceHostId: field('sourceHostId'), message: field('message'), wake: field('wake'), clientId: field('clientId'),
    deliveryId: field('deliveryId'), deadline: field('deadline'), recoveryDepth: field('recoveryDepth') };
  if (action === 'send' || action === 'recover_usage') {
    const command = buildPiCommand(broker, settings, host, { kind: 'rpc', cwd, sessionPath: path }, connection.remotePort);
    if (action === 'recover_usage') command.env.PIOP_USAGE_RECOVERY = '1';
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
  if (!['read', 'send', 'interrupt', 'recover_usage', 'locate'].includes(value.action)) throw new Error('Unknown orchestration action');
  return [value.sessionId, value.action];
}
