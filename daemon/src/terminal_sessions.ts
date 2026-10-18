import { loadAppSettings } from './settings';
import * as daemon from './daemon';
import { launchTerminalForOwner, queueInput, resizeProcess, stopTerminalProcess, type TerminalProcess, type TerminalRuntime } from './terminals';
import type { App } from './app';

const RETAINED_BYTES = 4 * 1024 * 1024;
/** Small appends are merged into blocks of this size, so many tiny outputs do not each keep a separate Buffer. */
const BLOCK_BYTES = 64 * 1024;
const EXITED_LIMIT = 64;
const MAX_INPUT_BYTES = 1024 * 1024;

function sessionPart(key: string): string {
  const index = key.lastIndexOf(':');
  return index < 0 ? key : key.slice(index + 1);
}

/** Saved terminal output. textEnd counts UTF-16 units. */
export class Transcript {
  chunks: Buffer[] = [];
  length = 0;
  inputDraft = '';
  textEnd = 0;
  updated = Date.now();
  running = true;
  used = false;
  /** The block that small appends are copied into, and the view of it that is the last chunk. */
  private block: Buffer | undefined;
  private blockView: Buffer | undefined;
  private blockUsed = 0;

  constructor(public sessionId: string, public hostId: string, public owner: string, public cwd: string, public generation: string, public creationOrder: number) {}

  append(data: string): void {
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length > BLOCK_BYTES / 4) this.chunks.push(bytes);
    else {
      // A trim or bytes() replaces the last chunk; then a new block starts.
      if (!this.block || this.chunks.at(-1) !== this.blockView || this.blockUsed + bytes.length > BLOCK_BYTES) {
        this.block = Buffer.allocUnsafe(BLOCK_BYTES);
        this.blockUsed = 0;
        this.chunks.push(this.block.subarray(0, 0));
      }
      bytes.copy(this.block, this.blockUsed);
      this.blockUsed += bytes.length;
      this.blockView = this.block.subarray(0, this.blockUsed);
      this.chunks[this.chunks.length - 1] = this.blockView;
    }
    this.length += bytes.length;
    this.textEnd += data.length;
    this.updated = Date.now();
    let discard = this.length - RETAINED_BYTES;
    if (discard <= 0) return;
    while (discard > 0 && this.chunks.length && this.chunks[0]!.length <= discard) {
      discard -= this.chunks[0]!.length;
      this.length -= this.chunks[0]!.length;
      this.chunks.shift();
    }
    if (discard > 0 && this.chunks.length) {
      let first = this.chunks[0]!;
      while (discard < first.length && (first[discard]! & 0xc0) === 0x80) discard += 1;
      this.chunks[0] = first.subarray(discard);
      this.length -= discard;
    }
  }

  bytes(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }
}

export function ownedBy(item: Transcript, owner: string): boolean { return item.owner === owner; }

export function start(runtime: TerminalRuntime, id: string, sessionKey: string, cwd: string, hostId: string, owner: string, generation: string): void {
  const existing = runtime.history.get(id);
  const order = existing ? existing.creationOrder : Math.max(0, ...[...runtime.history.values()].map(item => item.creationOrder)) + 1;
  runtime.history.set(id, new Transcript(sessionPart(sessionKey), hostId, owner, cwd, generation, order));
}

export function record(history: Map<string, Transcript>, id: string, data: string): void { history.get(id)?.append(data); }

export function event(history: Map<string, Transcript>, id: string, packet: any): any {
  const item = history.get(id);
  if (item) Object.assign(packet, { sessionId: item.sessionId, hostId: item.hostId, generation: item.generation, outputEnd: item.textEnd });
  return packet;
}

function changed(app: App, sessionId: string): void {
  app.emit('pi://event', { type: 'terminal_changed', sessionId, hostId: 'local' });
}

export function finish(history: Map<string, Transcript>, id: string): void {
  const item = history.get(id);
  if (item) item.running = false;
  const exited = [...history].filter(([, entry]) => !entry.running).sort((a, b) => a[1].updated - b[1].updated);
  for (const [key] of exited.slice(0, Math.max(0, exited.length - EXITED_LIMIT))) history.delete(key);
}

export function detach(runtime: TerminalRuntime, owner: string): void {
  for (const [id, item] of [...runtime.history]) if (item.owner === owner) runtime.history.delete(id);
}

export function sessionTerminals(runtime: TerminalRuntime, hostId: string, sessionIds: string[]): string[] {
  const ids = new Set<string>();
  for (const [id, item] of runtime.history) if (item.hostId === hostId && sessionIds.includes(item.sessionId)) ids.add(id);
  for (const [id, process] of runtime.processes) if (process.hostId === hostId && sessionIds.includes(sessionPart(process.sessionKey))) ids.add(id);
  return [...ids].sort();
}

export async function discardDrafts(runtime: TerminalRuntime, ownerPrefix: string): Promise<void> {
  const removed: Array<[string, TerminalProcess]> = [];
  for (const [id, item] of [...runtime.history]) {
    if (!item.sessionId.startsWith('draft-') || !item.owner.startsWith(ownerPrefix)) continue;
    runtime.history.delete(id);
    const process = runtime.processes.get(id);
    if (process) removed.push([id, process]);
  }
  const failures: string[] = [];
  for (const [id, process] of removed) {
    try { await stopTerminalProcess(process); } catch (error: any) { failures.push(id + ': ' + (error?.message ?? error)); }
    if (runtime.processes.get(id) === process) runtime.processes.delete(id);
  }
  if (failures.length) throw new Error('Could not close draft terminals: ' + failures.join('; '));
}

async function sessionOwned(app: App, sessionId: string, client: string, draftOwned: boolean, allowReleased: boolean): Promise<boolean> {
  if (sessionId.startsWith('draft-')) return draftOwned;
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, app.broker, settings, 'local');
  return (await connection.request({ type: 'conversation_owner', sessionId, clientId: client, allowReleased })) === true;
}

interface SharedRequest { app: App; runtime: TerminalRuntime; request: any; owner: string; client: string; sessionId: string }

export async function shared(app: App, connection: string, request: any): Promise<any> {
  const runtime = app.terminals;
  const action = request?.action;
  if (typeof action !== 'string') throw new Error('Missing terminal action');
  const source = typeof request.terminalConnectionId === 'string' ? request.terminalConnectionId : '';
  const ownerPrefix = 'shared:' + connection + ':' + source + ':';
  if (action === 'discard_drafts') { await discardDrafts(runtime, ownerPrefix); return null; }
  const client = request.clientId;
  if (typeof client !== 'string') throw new Error('Missing session client');
  const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey : '';
  const context: SharedRequest = { app, runtime, request, owner: ownerPrefix + client, client, sessionId: sessionPart(sessionKey) };
  if (action === 'list') return sharedList(context);
  const id = request.sharedTerminalId;
  if (typeof id !== 'string') throw new Error('Missing terminal ID');
  if (action === 'start') return sharedStart(context, id);
  if (action === 'reassign') return app.pi.lifecycle.run(() => updateShared(context, id, action));
  return updateShared(context, id, action);
}

async function sharedList(context: SharedRequest): Promise<any> {
  const owned = await sessionOwned(context.app, context.sessionId, context.client, true, false);
  const { runtime, sessionId, owner, request } = context;
  if (owned && !sessionId.startsWith('draft-')) {
    for (const [id, item] of runtime.history) {
      if (item.sessionId !== sessionId || item.hostId !== 'local') continue;
      item.owner = owner;
      const process = runtime.processes.get(id);
      if (process) process.windowLabel = owner;
    }
  }
  const entries = [...runtime.history].filter(([, item]) => item.sessionId === sessionId && item.hostId === 'local').sort((a, b) => a[1].creationOrder - b[1].creationOrder);
  return entries.map(([id, item]) => {
    const known = request?.known?.[id];
    const unchanged = known?.generation === item.generation && known?.outputEnd === item.textEnd;
    return { id, output: unchanged ? null : item.bytes().toString('utf8'), outputEnd: item.textEnd, inputDraft: item.inputDraft, generation: item.generation,
      owned: owned && (!sessionId.startsWith('draft-') || item.owner === owner), started: true, exited: !item.running };
  });
}

function dimension(request: any, key: string): number {
  const value = request?.[key];
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid ' + key);
  return Math.max(1, value);
}

function sharedStart(context: SharedRequest, id: string): Promise<any> {
  return context.app.pi.lifecycle.run(async () => {
    if (!(await sessionOwned(context.app, context.sessionId, context.client, true, false))) throw new Error('Take ownership of this session before changing its terminals');
    const item = context.runtime.history.get(id);
    if (item && item.sessionId !== context.sessionId) throw new Error('Terminal belongs to another session');
    if (item) item.owner = context.owner;
    const process = context.runtime.processes.get(id);
    if (process) process.windowLabel = context.owner;
    const cwd = context.request.cwd;
    if (typeof cwd !== 'string') throw new Error('Missing working directory');
    await launchTerminalForOwner(context.app, context.owner, context.runtime, {
      terminalId: id, sessionKey: 'local:' + context.sessionId, cwd, cols: dimension(context.request, 'cols'), rows: dimension(context.request, 'rows'), hostId: 'local',
    });
    changed(context.app, context.sessionId);
    return null;
  });
}

async function sharedAccess(context: SharedRequest, item: Transcript, action: string): Promise<void> {
  const sameOwner = item.owner === context.owner;
  if ((action === 'close' || action === 'close_unused') && sameOwner) return;
  const allowReleased = action === 'reassign' && sameOwner;
  if (!(await sessionOwned(context.app, item.sessionId, context.client, sameOwner, allowReleased))) throw new Error('Take ownership of this session before changing its terminals');
  if (action === 'reassign' && !(await sessionOwned(context.app, context.sessionId, context.client, true, false))) throw new Error('Take ownership of the destination session first');
}

function emitDraft(app: App, item: Transcript, id: string, data: string): void {
  app.emit('pi://event', { type: 'terminal_draft', terminalId: id, sessionId: item.sessionId, hostId: item.hostId, generation: item.generation, data });
}

async function updateShared(context: SharedRequest, id: string, action: string): Promise<any> {
  const { runtime, request, app } = context;
  if ((action === 'close' || action === 'close_unused') && !runtime.history.has(id) && !runtime.processes.has(id)) return null;
  const item = runtime.history.get(id);
  if (!item) throw new Error('Terminal is unavailable');
  const previousSession = item.sessionId;
  await sharedAccess(context, item, action);
  if (runtime.history.get(id) !== item) throw new Error('Terminal is unavailable');
  if (action === 'close_unused' && item.used) return null;
  const process = runtime.processes.get(id);
  switch (action) {
    case 'reassign':
      item.sessionId = context.sessionId;
      if (process) process.sessionKey = 'local:' + context.sessionId;
      break;
    case 'close': case 'close_unused':
      try { if (process) await stopTerminalProcess(process); }
      catch (error: any) { throw new Error('Could not close terminal ' + id + ': ' + (error?.message ?? error)); }
      finally {
        if (runtime.processes.get(id) === process) runtime.processes.delete(id);
        runtime.history.delete(id);
      }
      break;
    case 'draft': {
      const data = request.data;
      if (typeof data !== 'string') throw new Error('Missing terminal draft');
      if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Terminal draft exceeds 1 MiB');
      item.inputDraft = data;
      if (data) item.used = true;
      emitDraft(app, item, id, data);
      break;
    }
    case 'reply': case 'write': case 'write_with_draft': case 'adopt_draft': case 'write_and_clear_draft': {
      const data = request.data;
      if (typeof data !== 'string') throw new Error('Missing terminal input');
      if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Terminal input exceeds 1 MiB');
      if (action === 'write_and_clear_draft') {
        if (typeof request.expectedDraft !== 'string') throw new Error('Missing expected terminal draft');
        if (item.inputDraft !== request.expectedDraft) throw new Error('Terminal draft changed; review the input before sending again');
      }
      if (!process) throw new Error('Terminal is not running');
      const input = (action === 'reply' || action === 'write' || action === 'write_and_clear_draft' ? '' : item.inputDraft) + data;
      queueInput(process, input, 'Terminal input is busy');
      if (input && action !== 'reply') item.used = true;
      if (action !== 'reply' && action !== 'write' && item.inputDraft) { item.inputDraft = ''; emitDraft(app, item, id, ''); }
      break;
    }
    case 'resize': {
      const cols = dimension(request, 'cols');
      const rows = dimension(request, 'rows');
      if (!process) throw new Error('Terminal is not running');
      if (process.cols === cols && process.rows === rows) break;
      resizeProcess(process, cols, rows);
      const data = '\u001b[8;' + rows + ';' + cols + 't';
      item.append(data);
      app.emit('pi://event', { type: 'terminal_output', terminalId: id, sessionId: item.sessionId, hostId: item.hostId, generation: item.generation, outputEnd: item.textEnd, data });
      break;
    }
    default: throw new Error('Unknown terminal action');
  }
  if (action === 'close' || action === 'close_unused' || action === 'reassign') changed(app, previousSession);
  if (action === 'reassign' && context.sessionId !== previousSession) changed(app, context.sessionId);
  return null;
}
