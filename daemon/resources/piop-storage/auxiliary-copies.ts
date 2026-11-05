import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as io from './session-publication-io.ts';
import * as stateRecords from './session-records.ts';
import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import * as childIndex from '../session-broker/session-child-index.ts';
import * as names from '../session-broker/session-names.ts';

interface SourceCopy { kind: string; sourceId: string; sourcePath: string; sessionId: string; sessionPath: string; header: any; entries: any[]; timestamp: string; name: string | undefined }

interface PlannedCopy { kind: string; sourceId: string; sessionId: string; sessionPath: string; sourcePath: string; cwd: string; name: string | undefined; entries: any[]; retry: string | undefined; deliveryId: string | undefined }

export interface CopyPlan { copies: PlannedCopy[]; replacements: [string, string][]; retries: { sessionId: string; message: string; deliveryId: string }[] }

interface CopyRequest { root: string; source: { id: string; path: string }; target: { id: string; path: string }; cutoff?: string; cwd?: { from: string; to: string } }

interface CopyParent { sourceId: string; sessionId: string; entries: any[] }

const FORK_ERROR = 'Fork error: this chat was working when its main chat was forked. Its last prompt is sent again.';

const PROMPT_ABOVE = 'Retry the prompt above the fork error.';

const FORK_RETRIES = 'piop-fork-retries';

function readTranscript(file) {
  const body = fs.readFileSync(file, 'utf8');

  return stateRecords.merge(file, body.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
}

const finished = message => message?.role === 'assistant' && (['error', 'aborted'].includes(message.stopReason)
  || message.stopReason === 'stop' && !(Array.isArray(message.content) && message.content.some(part => part?.type === 'toolCall')));

const isPrompt = entry => entry.type === 'message' && entry.message?.role === 'user' || entry.type === 'custom_message' && entry.customType === 'piop-agent-message';

function promptText(entry) {
  if (entry.type === 'custom_message') {
    try { return String(JSON.parse(entry.content).message ?? ''); } catch { return typeof entry.content === 'string' ? entry.content : ''; }
  }
  const content = entry.message.content;

  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : '';
}

function shownBranch(file, header, entries) {
  const tree = entries.filter(entry => entry.type !== 'session' && !stateRecords.isCurrent(entry) && typeof entry.id === 'string');
  const byId = new Map<string, any>(tree.map(entry => [entry.id, entry]));
  const leaf = stateRecords.selectedLeaf(file, header.id, tree.at(-1)?.id ?? null);
  const branch: any[] = [];

  for (let id = leaf, seen = new Set<string>(); id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) { seen.add(id); branch.push(byId.get(id)); }

  return branch.reverse();
}

function interruptedWork(branch) {
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

function rewrite(value, replacements) {
  let text = JSON.stringify(value);

  for (const [from, to] of [...replacements].sort(([left], [right]) => right.length - left.length)) text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));

  return JSON.parse(text);
}

function activeChild(root, child) {
  const located = io.locate(root, child.sessionId);

  return located && io.inside(path.join(root, 'sessions'), located.path) ? located.path : undefined;
}

function planAuxiliaryCopies({ root, source, target, cutoff, cwd }: CopyRequest): CopyPlan {
  root = fs.realpathSync(root);
  const ids = new Map([[source.id, target.id]]);
  const replacements: [string, string][] = [[source.id, target.id], [source.path, target.path]];
  const copies: SourceCopy[] = [];
  const queue = [{ id: source.id, cutoff }];

  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];

    for (const child of childIndex.read(root, parent.id)?.children ?? []) {
      if (ids.has(child.sessionId)) continue;
      const file = activeChild(root, child);

      if (!file) continue;
      const entries = readTranscript(file);
      const header = entries[0];

      if (parent.cutoff !== undefined && Date.parse(header.timestamp) > Date.parse(parent.cutoff)) continue;
      const copyId = database.reserve(root);
      const timestamp = header.timestamp;
      const copyPath = path.join(path.dirname(target.path), String(timestamp).replace(/[:.]/g, '-') + '_' + copyId + '.jsonl');
      ids.set(child.sessionId, copyId);
      replacements.push([child.sessionId, copyId], [file, copyPath]);
      copies.push({ kind: child.kind, sourceId: child.sessionId, sourcePath: file, sessionId: copyId, sessionPath: copyPath, header, entries, timestamp, name: names.sessionName(file, child.sessionId) });
      queue.push({ id: child.sessionId, cutoff: parent.cutoff });
    }
  }

  const planned = copies.map((copy): PlannedCopy => {
    const work = interruptedWork(shownBranch(copy.sourcePath, copy.header, copy.entries));
    const folder = cwd && copy.header.cwd === cwd.from ? cwd.to : copy.header.cwd;
    const header = { ...copy.header, id: copy.sessionId, timestamp: copy.timestamp, cwd: folder };
    const body = [header, ...rewrite(copy.entries.slice(1), replacements), ...work ? rewrite(work.entries, replacements) : []];

    return { kind: copy.kind, sourceId: copy.sourceId, sessionId: copy.sessionId, sessionPath: copy.sessionPath, sourcePath: copy.sourcePath, cwd: folder, name: copy.name, entries: body, retry: work ? rewrite(work.message, replacements) : undefined, deliveryId: work ? randomUUID() : undefined };
  });

  return { copies: planned, replacements, retries: planned.filter((copy): copy is PlannedCopy & { retry: string; deliveryId: string } => copy.retry !== undefined).map(copy => ({ sessionId: copy.sessionId, message: copy.retry, deliveryId: copy.deliveryId })) };
}

function rewriteForkHistory(entries, plan) {
  const copied = plan.replacements.slice(2);

  return entries.map(entry => {
    const text = JSON.stringify(entry);

    return copied.some(([from]) => text.includes(JSON.stringify(from).slice(1, -1))) ? rewrite(entry, plan.replacements) : entry;
  });
}

function resultNotificationId(run) {
  return 'subagent-' + createHash('sha256').update(JSON.stringify([run.parentSessionId, run.sessionId, run.toolCallId, run.startedAt])).digest('hex');
}

function deliveredResults(entries) {
  return new Set(entries.flatMap(entry => {
    if (entry.type === 'custom_message' && entry.customType === 'piop-subagent-result') return typeof entry.details?.notificationId === 'string' ? [entry.details.notificationId] : [];
    const message = entry.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'toolResult' || message.toolName !== 'await_subagents' || !Array.isArray(message.details?.runs)) return [];

    return message.details.runs.flatMap(run => typeof run?.resultNotificationId === 'string' ? [run.resultNotificationId] : []);
  }));
}

const copySubagentRuns = onMainThread('auxiliary-copies.copySubagentRuns', (root: string, plan: CopyPlan, parents: CopyParent[]) => {
  root = fs.realpathSync(root);
  const copiedChildren = new Map(plan.copies.filter(copy => copy.kind === 'subagent').map(copy => [copy.sourceId, copy]));

  database.transaction(root, 'IMMEDIATE', () => {
    for (const parent of parents) {
      const runs = database.forkSourceSubagentRuns(root, parent.sourceId).filter(run => copiedChildren.has(run.sessionId));

      if (!runs.length) continue;
      database.markForkSubagentState(root, parent.sessionId);

      const results = deliveredResults(parent.entries);

      for (const saved of runs) {
        const child = copiedChildren.get(saved.sessionId);
        const run = rewrite(saved, plan.replacements);

        if (run.status === 'running' && child?.retry !== undefined) {
          Object.assign(run, { submission: 'accepted', deliveryIds: [child.deliveryId], taskNotificationId: child.deliveryId, observation: undefined });
        }

        if (run.resultDelivery === 'delivered' && !results.has(run.resultNotificationId)) {
          run.resultDelivery = 'pending';
          delete run.resultNotificationId;
        }

        database.saveForkSubagentRun(root, parent.sessionId, resultNotificationId(run), run.startedAt, run);
      }
    }
  });
});

function retryRecord(plan) {
  if (!plan.retries.length) return undefined;

  return { type: 'custom' as const, customType: FORK_RETRIES, id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), data: { pending: plan.retries } };
}

async function publishAuxiliaryCopies(root, plan, target, publishOne) {
  for (const copy of plan.copies) {
    await publishOne(copy.sessionPath, copy.entries, { ...copy.name ? { name: copy.name } : {}, goalSource: copy.sourcePath, dependencies: { workspace: { path: copy.cwd, kind: 'existing' } } });
  }

  const forkPath = plan.replacements[1][1];
  copySubagentRuns(root, plan, [{ sourceId: plan.replacements[0][0], sessionId: target.id, entries: readTranscript(forkPath) }, ...plan.copies.map(copy => ({ sourceId: copy.sourceId, sessionId: copy.sessionId, entries: copy.entries }))]);
}

export { FORK_RETRIES, FORK_ERROR, planAuxiliaryCopies, rewriteForkHistory, retryRecord, publishAuxiliaryCopies };
