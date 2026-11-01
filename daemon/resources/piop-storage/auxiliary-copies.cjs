const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./session-publication-io.cjs');
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

function rewrite(value, replacements) {
  let text = JSON.stringify(value);

  for (const [from, to] of [...replacements].sort(([left], [right]) => right.length - left.length)) text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));

  return JSON.parse(text);
}

function activeChild(root, child) {
  const located = io.locate(root, child.sessionId);

  return located && io.inside(path.join(root, 'sessions'), located.path) ? located.path : undefined;
}

function planAuxiliaryCopies({ root, source, target, cutoff, cwd }) {
  root = fs.realpathSync(root);
  const ids = new Map([[source.id, target.id]]);
  const replacements = [[source.id, target.id], [source.path, target.path]];
  const copies = [];
  const queue = [{ id: source.id, cutoff }];

  for (let index = 0; index < queue.length; index++) {
    for (const child of childIndex.read(root, queue[index].id)?.children ?? []) {
      if (ids.has(child.sessionId)) continue;
      const file = activeChild(root, child);

      if (!file) continue;
      const entries = readTranscript(file);
      const header = entries[0];

      if (queue[index].cutoff !== undefined && Date.parse(header.timestamp) > Date.parse(queue[index].cutoff)) continue;
      const copyId = database.reserve(root);
      const timestamp = header.timestamp;
      const copyPath = path.join(path.dirname(target.path), String(timestamp).replace(/[:.]/g, '-') + '_' + copyId + '.jsonl');
      ids.set(child.sessionId, copyId);
      replacements.push([child.sessionId, copyId], [file, copyPath]);
      copies.push({ kind: child.kind, sourceId: child.sessionId, sourcePath: file, sessionId: copyId, sessionPath: copyPath, header, entries, timestamp, name: names.sessionName(file, child.sessionId) });
      queue.push({ id: child.sessionId, cutoff: queue[index].cutoff });
    }
  }

  const planned = copies.map(copy => {
    const work = interruptedWork(shownBranch(copy.sourcePath, copy.header, copy.entries));
    const folder = cwd && copy.header.cwd === cwd.from ? cwd.to : copy.header.cwd;
    const header = { ...copy.header, id: copy.sessionId, timestamp: copy.timestamp, cwd: folder };
    const body = [header, ...rewrite(copy.entries.slice(1), replacements), ...work ? rewrite(work.entries, replacements) : []];

    return { kind: copy.kind, sourceId: copy.sourceId, sessionId: copy.sessionId, sessionPath: copy.sessionPath, sourcePath: copy.sourcePath, cwd: folder, name: copy.name, entries: body, retry: work ? rewrite(work.message, replacements) : undefined, deliveryId: work ? randomUUID() : undefined };
  });

  return { copies: planned, replacements, retries: planned.filter(copy => copy.retry !== undefined).map(copy => ({ sessionId: copy.sessionId, message: copy.retry, deliveryId: copy.deliveryId })) };
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

function copySubagentRuns(root, plan, parents) {
  root = fs.realpathSync(root);
  const copiedChildren = new Map(plan.copies.filter(copy => copy.kind === 'subagent').map(copy => [copy.sourceId, copy]));
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');

    for (const parent of parents) {
      const rows = db.prepare('SELECT run_json FROM session_subagent_runs WHERE session_id=? ORDER BY started_at, run_id').all(parent.sourceId);
      const runs = rows.map(row => JSON.parse(row.run_json)).filter(run => copiedChildren.has(run.sessionId));

      if (!runs.length) continue;
      db.prepare('INSERT INTO session_subagent_state VALUES (?) ON CONFLICT(session_id) DO NOTHING').run(parent.sessionId);

      const results = deliveredResults(parent.entries);

      for (const saved of runs) {
        const child = copiedChildren.get(saved.sessionId);
        const run = rewrite(saved, plan.replacements);

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

    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function retryRecord(plan) {
  if (!plan.retries.length) return undefined;

  return { type: 'custom', customType: FORK_RETRIES, id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), data: { pending: plan.retries } };
}

async function publishAuxiliaryCopies(root, plan, target, publishOne) {
  for (const copy of plan.copies) {
    await publishOne(copy.sessionPath, copy.entries, { ...copy.name ? { name: copy.name } : {}, goalSource: copy.sourcePath, dependencies: { workspace: { path: copy.cwd, kind: 'existing' } } });
  }

  const forkPath = plan.replacements[1][1];
  copySubagentRuns(root, plan, [{ sourceId: plan.replacements[0][0], sessionId: target.id, entries: readTranscript(forkPath) }, ...plan.copies.map(copy => ({ sourceId: copy.sourceId, sessionId: copy.sessionId, entries: copy.entries }))]);
}

module.exports = { FORK_RETRIES, FORK_ERROR, planAuxiliaryCopies, rewriteForkHistory, retryRecord, publishAuxiliaryCopies };
