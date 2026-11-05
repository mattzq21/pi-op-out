import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as stateRecords from '../piop-storage/index.ts';
import * as database from '../session-database/index.ts';
import { forkChat } from '../storage-operations/index.ts';
import * as names from '../piop-storage/index.ts';
import { readSessionHeader } from './session-header.ts';
import { onMainThread } from '../session-database/index.ts';
import * as lifecycle from './lifecycle.ts';

export interface BranchHistoryRequest {
  root: string;
  sourcePath: string;
  sessionId: string;
  cwd: string;
  entries: any[];
  leafId: string;
  entryId: string;
  keepName?: boolean;
}

export interface BranchHistoryResult {
  sessionPath: string;
  forkSource: { sessionId: string; sessionPath: string; entryId: string };
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function requireUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid ' + label);
}

function requirePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) throw new Error('Invalid ' + label);
}

function storageRoot(root: string, sessionPath: string): string {
  requirePath(root, 'storage root');
  const canonical = fs.realpathSync(root);
  if (database.storageRoot(sessionPath) !== canonical) throw new Error('The conversation is outside this storage root');
  return canonical;
}

function selectHistory(entries: any[], leafId: string, entryId: string): any[] {
  if (!stateRecords.canFork(entries)) throw new Error("Only main chats can be forked");
  const byId = new Map<string, any>(entries.filter(entry => entry?.type !== 'session' && typeof entry?.id === 'string').map(entry => [entry.id, entry]));
  const selected = byId.get(entryId);
  if (!selected) throw new Error('The selected response is no longer in this conversation');
  if (!stateRecords.forkPoint(selected)) throw new Error('Select a finished or stopped final response or a compaction to branch from');
  const history: any[] = [];
  const seen = new Set<string>();
  for (let id = leafId; id; id = byId.get(id)?.parentId) {
    if (seen.has(id)) throw new Error('The conversation history has a cycle');
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error('The conversation history is incomplete');
    history.push(entry);
  }
  history.reverse();
  const end = history.findIndex(entry => entry.id === entryId);
  if (end < 0) throw new Error('The selected response is not on the current branch');
  let parentId: string | null = null;
  return history.slice(0, end + 1).filter(entry => !stateRecords.isCurrent(entry)).map(entry => {
    const copy = { ...structuredClone(entry), parentId };
    parentId = entry.id;
    return copy;
  });
}

function currentState(entries: any[]): Map<string, any> {
  const current = new Map<string, any>();
  for (const entry of entries) if (entry?.type !== 'session' && stateRecords.isCurrent(entry)) current.set(stateRecords.stateKey(entry), { ...structuredClone(entry), parentId: null });
  return current;
}

function userText(history: any[]): string | undefined {
  const entry = history.find(item => item.type === 'message' && item.message?.role === 'user');
  const content = entry?.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join(' ') : '';
  const line = text.trim().split('\n')[0].trim();
  return line ? line.slice(0, 80) : undefined;
}

function branchName(sourceName: string | undefined, history: any[]): string { return (sourceName || userText(history) || 'Chat') + ' (branch)'; }

async function publishBranchHistory(request: BranchHistoryRequest): Promise<BranchHistoryResult> {
  const { sourcePath, sessionId, entries, leafId, entryId } = request ?? ({} as BranchHistoryRequest);
  requirePath(sourcePath, 'source conversation path');
  requireUuid(sessionId, 'branch identity');
  requirePath(request.cwd, 'branch folder');
  if (!Array.isArray(entries) || typeof leafId !== 'string' || typeof entryId !== 'string') throw new Error('Invalid branch history request');
  const root = storageRoot(request.root, sourcePath);
  const source = readSessionHeader(sourcePath);
  if (!source) throw new Error('The source conversation has no saved identity');
  if (source.id === sessionId) throw new Error('The branch identity is already in use');
  const selected = selectHistory(entries, leafId, entryId);
  const current = currentState(entries);
  const timestamp = new Date().toISOString();
  const sessionPath = path.join(path.dirname(sourcePath), timestamp.replace(/[:.]/g, '-') + '_' + sessionId + '.jsonl');
  const cwd = fs.realpathSync(request.cwd);
  current.set('piop-input-hold', { type: 'custom', customType: 'piop-input-hold', data: { held: true }, id: randomUUID(), parentId: null, timestamp });
  const forkSource = { sessionId: source.id, sessionPath: sourcePath, entryId };
  const header = { type: 'session', version: source.version, id: sessionId, timestamp, cwd, parentSession: sourcePath, piopForkSource: forkSource };
  const sourceName = names.sessionName(sourcePath, source.id);
  const name = request.keepName === true ? sourceName : branchName(sourceName, selected);

  try {
    forkChat(root, { path: sessionPath, entries: [header, ...selected, ...current.values()], ...name === undefined ? {} : { name }, goalSource: source.id,
      source: source.id, ...selected.length ? { cutoff: selected.at(-1).timestamp } : {}, cwd: { from: source.cwd, to: cwd } });
  } catch (error) {
    try { await discardBranchHistory(root, sessionId, sessionPath); }
    catch (cleanup) { throw new Error('Could not create the branch: ' + message(error) + '\nCleanup failed: ' + message(cleanup), { cause: error }); }
    throw new Error('Could not create the branch: ' + message(error), { cause: error });
  }
  return { sessionPath, forkSource };
}

function ownedTranscript(file: string, sessionId: string): void {
  const header = readSessionHeader(file);
  if (!header || header.id !== sessionId || !(header as any).piopForkSource) throw new Error('Refusing to remove a conversation that is not this branch: ' + file);
}

const releaseReservation = onMainThread('chat-branch-history.releaseReservation', (root: string, sessionId: string) => {
  database.releaseReservedSession(root, sessionId);
});

// Removes the branch sessionId: its rows, and then its files.
async function discardBranchHistory(root: string, sessionId: string, sessionPath: string | null): Promise<void> {
  requireUuid(sessionId, 'branch identity');
  if (sessionPath !== null) {
    requirePath(sessionPath, 'branch path');
    if (!path.basename(sessionPath).endsWith('_' + sessionId + '.jsonl')) throw new Error('The branch path does not bind its identity');
  }
  requirePath(root, 'storage root');
  root = fs.realpathSync(root);
  const registered = database.lookup(root, sessionId);
  const target = sessionPath ?? registered ?? null;
  if (target !== null && database.storageRoot(target) !== root) throw new Error('The branch is outside active conversation storage');
  if (target !== null && fs.existsSync(target)) ownedTranscript(target, sessionId);
  if (registered === null) releaseReservation(root, sessionId);
  else if (registered !== undefined) {
    if (registered !== target) throw new Error('This branch identity belongs to another conversation: ' + registered);
    lifecycle.forget(root, [sessionId]);
  }
  if (target !== null) {
    fs.rmSync(target.slice(0, -'.jsonl'.length) + '.snapshots', { recursive: true, force: true });
    fs.rmSync(target, { force: true });
  }
}

export { publishBranchHistory, discardBranchHistory };
