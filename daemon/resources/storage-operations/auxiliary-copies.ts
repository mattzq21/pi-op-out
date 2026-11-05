import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as stateRecords from '../piop-storage/index.ts';
import * as database from '../session-database/index.ts';

export interface PlannedCopy {
  kind: string; sourceId: string; sessionId: string; sessionPath: string; name: string | undefined;
  entries: any[]; retry: string | undefined; deliveryId: string | undefined;
}

export interface CopyPlan {
  ids: [string, string][];
  copies: PlannedCopy[];
  retries: { sessionId: string; message: string; deliveryId: string }[];
}

export interface CopyParent { sourceId: string; sessionId: string; entries: any[] }

interface CopySource {
  kind: string; sourceId: string; sourcePath: string; sessionId: string; sessionPath: string;
  header: any; entries: any[]; name: string | undefined;
}

const FORK_ERROR = 'Fork error: this chat was working when its main chat was forked. Its last prompt is sent again.';

const PROMPT_ABOVE = 'Retry the prompt above the fork error.';

const FORK_RETRIES = 'piop-fork-retries';

function readTranscript(file: string): any[] {
  const body = fs.readFileSync(file, 'utf8');

  return stateRecords.merge(file, body.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
}

const finished = (message: any) => message?.role === 'assistant' && (['error', 'aborted'].includes(message.stopReason)
  || message.stopReason === 'stop' && !(Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'toolCall')));

const isPrompt = (entry: any) => entry.type === 'message' && entry.message?.role === 'user' || entry.type === 'custom_message' && entry.customType === 'piop-agent-message';

function promptText(entry: any): string {
  if (entry.type === 'custom_message') {
    try { return String(JSON.parse(entry.content).message ?? ''); } catch { return typeof entry.content === 'string' ? entry.content : ''; }
  }
  const content = entry.message.content;

  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('') : '';
}

function shownBranch(file: string, header: any, entries: any[]): any[] {
  const tree = entries.filter((entry: any) => entry.type !== 'session' && !stateRecords.isCurrent(entry) && typeof entry.id === 'string');
  const byId = new Map<string, any>(tree.map(entry => [entry.id, entry]));
  const leaf = stateRecords.selectedLeaf(file, header.id, tree.at(-1)?.id ?? null);
  const branch: any[] = [];

  for (let id = leaf, seen = new Set<string>(); id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) { seen.add(id); branch.push(byId.get(id)); }

  return branch.reverse();
}

function interruptedWork(branch: any[]): { message: string; entries: any[] } | undefined {
  const messages = branch.filter(entry => entry.type === 'message' || isPrompt(entry));
  const last = messages.at(-1);

  if (!last || last.type === 'message' && finished(last.message)) return undefined;
  const answer = branch.findLast(entry => entry.type === 'message' && finished(entry.message));
  const prompt = branch.findLast(entry => isPrompt(entry) && (!answer || branch.indexOf(entry) > branch.indexOf(answer)));

  if (!prompt) return undefined;
  const model = branch.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant')?.message ?? {};
  const promptCopy = { ...structuredClone(prompt), id: randomUUID(), parentId: answer?.id ?? null };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const error = { type: 'message', id: randomUUID(), parentId: promptCopy.id, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [], api: model.api ?? 'piop', provider: model.provider ?? 'piop', model: model.model ?? 'fork', usage: zero, stopReason: 'error', errorMessage: FORK_ERROR, timestamp: Date.now() } };

  return { message: promptText(prompt).trim() ? promptText(prompt) : PROMPT_ABOVE, entries: [promptCopy, error] };
}

// Gives value with each ID of ids (pairs of old and new) replaced. The file names of copied chats hold their IDs, so the
// paths of copies in the same folder change with them.
function rewrite(value: any, ids: [string, string][]): any {
  let text = JSON.stringify(value);

  for (const [from, to] of ids) text = text.split(from).join(to);

  return JSON.parse(text);
}

// The copies of the side chats, reviews and subagents under the chat sourceId (and under them) that were made by cutoff,
// for its fork target. Each copy gets a reserved ID and a transcript next to the fork; with cwd, copies that worked in
// cwd.from work in cwd.to.
function planAuxiliaryCopies({ root, sourceId, target, cutoff, cwd }: { root: string; sourceId: string; target: { id: string; path: string }; cutoff?: string; cwd?: { from: string; to: string } }): CopyPlan {
  root = fs.realpathSync(root);
  const ids: [string, string][] = [[sourceId, target.id]];
  const copied = new Set([sourceId]);
  const copies: CopySource[] = [];
  const queue = [sourceId];

  for (let index = 0; index < queue.length; index++) {
    for (const child of stateRecords.children(root, queue[index])) {
      if (copied.has(child.sessionId) || child.archived) continue;
      const file = database.lookup(root, child.sessionId);
      if (!file) continue;
      const entries = readTranscript(file);
      const header = entries[0];

      if (cutoff !== undefined && Date.parse(header.timestamp) > Date.parse(cutoff)) continue;
      const copyId = database.reserve(root);
      copied.add(child.sessionId);
      ids.push([child.sessionId, copyId]);
      copies.push({ kind: child.kind, sourceId: child.sessionId, sourcePath: file, sessionId: copyId, sessionPath: path.join(path.dirname(target.path), String(header.timestamp).replace(/[:.]/g, '-') + '_' + copyId + '.jsonl'), header, entries, name: stateRecords.sessionName(file, child.sessionId) });
      queue.push(child.sessionId);
    }
  }

  const planned = copies.map((copy): PlannedCopy => {
    const work = interruptedWork(shownBranch(copy.sourcePath, copy.header, copy.entries));
    const folder = cwd && copy.header.cwd === cwd.from ? cwd.to : copy.header.cwd;
    const header = { ...copy.header, id: copy.sessionId, cwd: folder };
    const entries = [header, ...rewrite(copy.entries.slice(1), ids), ...work ? rewrite(work.entries, ids) : []];

    return { kind: copy.kind, sourceId: copy.sourceId, sessionId: copy.sessionId, sessionPath: copy.sessionPath, name: copy.name, entries, retry: work ? rewrite(work.message, ids) : undefined, deliveryId: work ? randomUUID() : undefined };
  });

  return { ids, copies: planned, retries: planned.filter(copy => copy.retry !== undefined).map(copy => ({ sessionId: copy.sessionId, message: copy.retry as string, deliveryId: copy.deliveryId as string })) };
}

// The fork's history with the IDs of copied chats replaced, in the entries that name one.
function rewriteForkHistory(entries: any[], plan: CopyPlan): any[] {
  const copied = plan.ids.slice(1);

  return entries.map(entry => {
    const text = JSON.stringify(entry);

    return copied.some(([from]) => text.includes(from)) ? rewrite(entry, plan.ids) : entry;
  });
}

function resultNotificationId(run: any): string {
  return 'subagent-' + createHash('sha256').update(JSON.stringify([run.parentSessionId, run.sessionId, run.toolCallId, run.startedAt])).digest('hex');
}

function deliveredResults(entries: any[]): Set<string> {
  return new Set(entries.flatMap(entry => {
    if (entry.type === 'custom_message' && entry.customType === 'piop-subagent-result') return typeof entry.details?.notificationId === 'string' ? [entry.details.notificationId] : [];
    const message = entry.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'toolResult' || message.toolName !== 'await_subagents' || !Array.isArray(message.details?.runs)) return [];

    return message.details.runs.flatMap((run: any) => typeof run?.resultNotificationId === 'string' ? [run.resultNotificationId] : []);
  }));
}

// Copies, inside the caller's transaction, the subagent runs of each parent (the fork and its copies) whose subagent was
// copied. parents are { sourceId, sessionId, entries }.
function copySubagentRuns(root: string, plan: CopyPlan, parents: CopyParent[]): void {
  const copiedChildren = new Map(plan.copies.filter(copy => copy.kind === 'subagent').map(copy => [copy.sourceId, copy]));

  for (const parent of parents) {
    const runs = database.forkSourceSubagentRuns(root, parent.sourceId).filter(run => copiedChildren.has(run.sessionId));

    if (!runs.length) continue;
    const results = deliveredResults(parent.entries);

    for (const saved of runs) {
      const child = copiedChildren.get(saved.sessionId) as PlannedCopy;
      const run = rewrite(saved, plan.ids);

      if (run.status === 'running' && child.retry !== undefined) {
        Object.assign(run, { submission: 'accepted', deliveryIds: [child.deliveryId], taskNotificationId: child.deliveryId, observation: undefined });
      }

      if (run.resultDelivery === 'delivered' && !results.has(run.resultNotificationId)) {
        run.resultDelivery = 'pending';
        delete run.resultNotificationId;
      }

      database.saveForkSubagentRun(root, parent.sessionId, resultNotificationId(run), run.startedAt, run);
    }
  }
}

function retryRecord(plan: CopyPlan): any {
  if (!plan.retries.length) return undefined;

  return { type: 'custom', customType: FORK_RETRIES, id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), data: { pending: plan.retries } };
}

export { planAuxiliaryCopies, rewriteForkHistory, retryRecord, copySubagentRuns };
