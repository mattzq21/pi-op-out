const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const stateRecords = require('./session-records.cjs');
const database = require('../session-database.cjs');
const childIndex = require('../session-broker/session-child-index.cjs');
const names = require('../session-broker/session-names.cjs');

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
  const byId = new Map(tree.map(entry => [entry.id, entry]));
  const leaf = stateRecords.selectedLeaf(file, header.id, tree.at(-1)?.id ?? null);
  const branch = [];

  for (let id = leaf, seen = new Set(); id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) { seen.add(id); branch.push(byId.get(id)); }

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

// Gives value with each ID of ids (pairs of old and new) replaced. The file names of copied chats hold their IDs, so the
// paths of copies in the same folder change with them.
function rewrite(value, ids) {
  let text = JSON.stringify(value);

  for (const [from, to] of ids) text = text.split(from).join(to);

  return JSON.parse(text);
}

// The copies of the side chats, reviews and subagents under the chat sourceId (and under them) that were made by cutoff,
// for its fork target. Each copy gets a reserved ID and a transcript next to the fork; with cwd, copies that worked in
// cwd.from work in cwd.to.
function planAuxiliaryCopies({ root, sourceId, target, cutoff, cwd }) {
  root = fs.realpathSync(root);
  const ids = [[sourceId, target.id]];
  const copied = new Set([sourceId]);
  const copies = [];
  const queue = [sourceId];

  for (let index = 0; index < queue.length; index++) {
    for (const child of childIndex.children(root, queue[index])) {
      if (copied.has(child.sessionId) || child.archived) continue;
      const file = database.lookup(root, child.sessionId);
      const entries = readTranscript(file);
      const header = entries[0];

      if (cutoff !== undefined && Date.parse(header.timestamp) > Date.parse(cutoff)) continue;
      const copyId = database.reserve(root);
      copied.add(child.sessionId);
      ids.push([child.sessionId, copyId]);
      copies.push({ kind: child.kind, sourceId: child.sessionId, sourcePath: file, sessionId: copyId, sessionPath: path.join(path.dirname(target.path), String(header.timestamp).replace(/[:.]/g, '-') + '_' + copyId + '.jsonl'), header, entries, name: names.sessionName(file, child.sessionId) });
      queue.push(child.sessionId);
    }
  }

  const planned = copies.map(copy => {
    const work = interruptedWork(shownBranch(copy.sourcePath, copy.header, copy.entries));
    const folder = cwd && copy.header.cwd === cwd.from ? cwd.to : copy.header.cwd;
    const header = { ...copy.header, id: copy.sessionId, cwd: folder };
    const entries = [header, ...rewrite(copy.entries.slice(1), ids), ...work ? rewrite(work.entries, ids) : []];

    return { kind: copy.kind, sourceId: copy.sourceId, sessionId: copy.sessionId, sessionPath: copy.sessionPath, name: copy.name, entries, retry: work ? rewrite(work.message, ids) : undefined, deliveryId: work ? randomUUID() : undefined };
  });

  return { ids, copies: planned, retries: planned.filter(copy => copy.retry !== undefined).map(copy => ({ sessionId: copy.sessionId, message: copy.retry, deliveryId: copy.deliveryId })) };
}

// The fork's history with the IDs of copied chats replaced, in the entries that name one.
function rewriteForkHistory(entries, plan) {
  const copied = plan.ids.slice(1);

  return entries.map(entry => {
    const text = JSON.stringify(entry);

    return copied.some(([from]) => text.includes(from)) ? rewrite(entry, plan.ids) : entry;
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

// Copies, inside the caller's transaction, the subagent runs of each parent (the fork and its copies) whose subagent was
// copied. parents are { sourceId, sessionId, entries }.
function copySubagentRuns(db, plan, parents) {
  const copiedChildren = new Map(plan.copies.filter(copy => copy.kind === 'subagent').map(copy => [copy.sourceId, copy]));
  for (const parent of parents) {
    const rows = db.prepare('SELECT run_json FROM session_subagent_runs WHERE session_id=? ORDER BY started_at, run_id').all(parent.sourceId);
    const runs = rows.map(row => JSON.parse(row.run_json)).filter(run => copiedChildren.has(run.sessionId));

    if (!runs.length) continue;

    const results = deliveredResults(parent.entries);

    for (const saved of runs) {
      const child = copiedChildren.get(saved.sessionId);
      const run = rewrite(saved, plan.ids);

      if (run.status === 'running' && child.retry !== undefined) {
        Object.assign(run, { submission: 'accepted', deliveryIds: [child.deliveryId], taskNotificationId: child.deliveryId, observation: undefined });
      }

      if (run.resultDelivery === 'delivered' && !results.has(run.resultNotificationId)) {
        run.resultDelivery = 'pending';
        delete run.resultNotificationId;
      }

      db.prepare('INSERT INTO session_subagent_runs VALUES (?, ?, ?, ?) ON CONFLICT(session_id, run_id) DO UPDATE SET run_json=excluded.run_json')
        .run(parent.sessionId, resultNotificationId(run), run.startedAt, JSON.stringify(run));
    }
  }
}

function retryRecord(plan) {
  if (!plan.retries.length) return undefined;

  return { type: 'custom', customType: FORK_RETRIES, id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), data: { pending: plan.retries } };
}

module.exports = { planAuxiliaryCopies, rewriteForkHistory, retryRecord, copySubagentRuns };
