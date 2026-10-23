const stateRecords = require('./piop-storage/session-records.cjs');
const fs = require('node:fs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { reviewVisibility } = require('./piop-storage/session-publication.cjs');

const parentSchema = Type.Object({ parentSessionId: Type.String(), sessionId: Type.Optional(Type.String()) });

const entrySchema = Type.Object({ type: Type.String() });

const resumeSchema = Type.Object({ message: Type.String() });

const PREVIEW_CODE_POINTS = 100;

function text(message) {
  return Check(Type.String(), message.content) ? message.content : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
}

function userPrompt(content) {
  return content.replace(/^(?:\s*<skill\b[^>]*>\s*[\s\S]*?<\/skill>\s*)+/, '').trim();
}

function timestamp(value) {
  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value ?? ''));

  return Number.isFinite(parsed) ? parsed : 0;
}

class SessionIndex {
  header;
  name;
  subagentParentId;
  ownSubagentParentId;
  review = false;
  reviewParentId;
  first = '';
  hasUserMessage = false;
  preview = '';
  count = 0;
  cost = 0;
  lastMessageAt = 0;
  bytes = 0;
  lineNumber = 0;
  damagedLines = [];
  interruptedBytes = 0;
  resumes = new Set();
  /** Each entry's parent and, for a message, what the chat list shows of it. The chat list follows the branch that ends at the last entry. */
  nodes = new Map();
  leaf = null;
  unnamed = 0;

  metadata(entry) {
    if (entry.type === 'custom') {
      const data = entry.data ?? {};

      if (Check(parentSchema, data)) this.parent(entry.customType, data);

      if (entry.customType === 'pi-desktop-resume' && Check(resumeSchema, data)) this.resumes.add(data.message);
    }

  }

  parent(kind, data) {
    const own = data.sessionId === this.header.id;
    const legacy = data.sessionId === undefined && !this.header.parentSession;

    if (!own && !legacy) return;

    if (kind === 'piop-review-parent') { this.review = true; this.reviewParentId = data.parentSessionId; }

    if (kind !== 'piop-subagent-parent') return;

    if (own) this.ownSubagentParentId = data.parentSessionId;
    else this.subagentParentId = data.parentSessionId;
  }

  /** What the chat list needs of a message entry, or undefined for other entries and resume prompts. */
  messageRecord(entry) {
    if (entry.type !== 'message') return undefined;
    const message = entry.message || {};
    let content = text(message);

    if (message.role === 'user' && this.resumes.has(content)) return undefined;

    if (message.role === 'user') content = userPrompt(content);

    return { role: message.role, content: content.slice(0, 2000), timestamp: message.role === 'user' ? timestamp(message.timestamp ?? entry.timestamp) : 0 };
  }

  recordMessage(record) {
    if (record.role === 'user') {
      this.hasUserMessage = true;
      this.lastMessageAt = Math.max(this.lastMessageAt, record.timestamp);
    }

    this.count++;

    if (record.content) {
      if (!this.first && record.role === 'user') this.first = record.content;
      this.preview = [...record.content.slice(0, PREVIEW_CODE_POINTS * 2)].slice(0, PREVIEW_CODE_POINTS).join('');
    }
  }

  /** Records the messages on the branch that ends at the last entry, oldest first. */
  recordBranch() {
    const branch = [];
    const seen = new Set();

    for (let id = this.leaf; id !== null && this.nodes.has(id) && !seen.has(id); id = this.nodes.get(id).parentId) {
      seen.add(id);
      branch.push(this.nodes.get(id).record);
    }

    for (const record of branch.reverse()) if (record) this.recordMessage(record);
  }

  recordCost(message) {
    const amount = message.usage?.cost?.total;

    if (Number.isFinite(amount) && amount >= 0) this.cost += amount;
  }

  line(line, terminated = true) {
    this.bytes += line.length + Number(terminated);
    this.lineNumber++;
    if (!terminated) { this.interruptedBytes = line.length; return; }
    let entry;

    try { entry = JSON.parse(line.toString('utf8')); } catch { this.damagedLines.push(this.lineNumber); return; }

    if (!Check(entrySchema, entry)) { this.damagedLines.push(this.lineNumber); return; }

    if (!this.header) {
      if (entry.type !== 'session') throw Error('Invalid session header');
      this.header = entry;

      return;
    }

    this.metadata(entry);
    if (stateRecords.isCurrent(entry)) return;

    if (entry.type === 'usage') this.recordCost(entry);

    // Cost counts every response, also on branches the chat later left.
    if (entry.type === 'message' && ['assistant', 'toolResult'].includes(entry.message?.role)) this.recordCost(entry.message);
    const id = typeof entry.id === 'string' ? entry.id : `#${++this.unnamed}`;
    const parentId = typeof entry.id !== 'string' ? this.leaf : typeof entry.parentId === 'string' ? entry.parentId : null;
    this.nodes.set(id, { parentId, record: this.messageRecord(entry) });
    this.leaf = id;
  }

  visible(path) {
    if (!this.review) return true;

    if (!reviewVisibility(path, this.reviewParentId)) return false;
    this.name = 'Review awaiting parent publication';

    return true;
  }

  summary(path) {
    if (this.header) this.name = stateRecords.sessionName(path, this.header.id);
    if (this.header) {
      this.leaf = stateRecords.selectedLeaf(path, this.header.id, this.leaf);
      if (this.leaf !== null && !this.nodes.has(this.leaf)) throw new Error('The saved branch points to a missing entry');
    }
    this.recordBranch();
    if (this.interruptedBytes) console.warn(`${path}: last write was interrupted; ignored ${this.interruptedBytes} bytes`);
    if (this.damagedLines.length) {
      const notice = `Incomplete chat history; damaged record lines: ${this.damagedLines.join(', ')}`;
      console.error(`${path}: ${notice}`);
      this.preview = notice;
    }
    if (!this.header || !this.visible(path)) return;

    const forkSourceId = typeof this.header.piopForkSource?.sessionId === 'string' && this.header.piopForkSource.sessionId ? this.header.piopForkSource.sessionId : undefined;

    return { path, id: this.header.id || '', cwd: this.header.cwd || 'Unknown project', name: stateRecords.capSessionName(this.name || this.first || 'Untitled session'), preview: this.preview, messageCount: this.count, lastMessageAt: this.lastMessageAt, apiCost: this.cost, explicitlyNamed: !!this.name, hasUserMessage: this.hasUserMessage, bytes: this.bytes, subagentParentId: this.ownSubagentParentId ?? this.subagentParentId, forkSourceId };
  }
}

async function indexFile(path) {
  const index = new SessionIndex();
  let pending = [];
  let state;
  const feed = line => {
    index.line(line);
    if (!index.header) return;
    if (!state) {
      state = new Map();
      for (const record of stateRecords.records(path, index.header.id)) {
        const group = state.get(record.after) ?? [];
        group.push(record.entry);
        state.set(record.after, group);
      }
    }
    let entry;
    try { entry = JSON.parse(line.toString("utf8")); } catch { return; }
    const after = entry.type === "session" ? null : entry.id;
    for (const record of state.get(after) ?? []) {
      const bytes = index.bytes, lineNumber = index.lineNumber;
      index.line(Buffer.from(JSON.stringify(record)));
      index.bytes = bytes;
      index.lineNumber = lineNumber;
    }
  };

  for await (const chunk of fs.createReadStream(path)) {
    let start = 0, end;

    while ((end = chunk.indexOf(10, start)) >= 0) {
      pending.push(chunk.subarray(start, end));
      const line = Buffer.concat(pending);
      pending = []; start = end + 1;
      feed(line);
    }

    if (start < chunk.length) pending.push(chunk.subarray(start));
  }

  if (pending.length) index.line(Buffer.concat(pending), false);

  return index.summary(path);
}

/** Returns the summary of each readable transcript in request.paths. Unreadable transcripts are reported in warnings. */
async function indexSessions(request) {
  if (!Array.isArray(request.paths) || !request.paths.every(path => typeof path === 'string')) throw new Error('Invalid session summary request');
  const summaries = [];
  const warnings = [];

  for (const path of request.paths) {
    try {
      const summary = await indexFile(path);

      if (summary) summaries.push(summary);
    } catch (error) { warnings.push(`${path}: ${error.message}`); }
  }

  return { summaries, warnings };
}

module.exports = { indexSessions };
