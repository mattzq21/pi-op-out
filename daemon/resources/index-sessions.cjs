const fs = require('node:fs');
const { hostScript } = require('./host-script.cjs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { reviewVisibility } = require('./session-broker/session-publication.cjs');

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
  resumes = new Set();

  metadata(entry) {
    if (entry.type === 'custom') {
      const data = entry.data ?? {};

      if (Check(parentSchema, data)) this.parent(entry.customType, data);

      if (entry.customType === 'pi-desktop-resume' && Check(resumeSchema, data)) this.resumes.add(data.message);
    }

    if (entry.type === 'session_info' && entry.name?.trim()) this.name = entry.name.trim().slice(0, 2000);
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

  message(entry) {
    if (entry.type !== 'message') return;
    const message = entry.message || {};
    const content = text(message);

    if (message.role === 'user' && this.resumes.has(content)) return;
    this.recordMessage(message, content, entry);
  }

  recordMessage(message, content, entry) {
    if (message.role === 'user') {
      this.hasUserMessage = true;
      this.lastMessageAt = Math.max(this.lastMessageAt, timestamp(message.timestamp ?? entry.timestamp));
      content = userPrompt(content);
    }

    this.count++;

    if (content) {
      if (!this.first && message.role === 'user') this.first = content.slice(0, 2000);
      this.preview = [...content.slice(0, PREVIEW_CODE_POINTS * 2)].slice(0, PREVIEW_CODE_POINTS).join('');
    }

    if (message.role === 'assistant' || message.role === 'toolResult') this.recordCost(message);
  }

  recordCost(message) {
    const amount = message.usage?.cost?.total;

    if (Number.isFinite(amount) && amount >= 0) this.cost += amount;
  }

  line(line, terminated = true) {
    this.bytes += line.length + Number(terminated);
    let entry;

    try { entry = JSON.parse(line.toString('utf8')); } catch { return; }

    if (!Check(entrySchema, entry)) { console.error('Skipped a malformed conversation record while indexing');

    return; }

    if (!this.header) {
      if (entry.type !== 'session') throw Error('Invalid session header');
      this.header = entry;

      return;
    }

    this.metadata(entry);

    if (entry.type === 'usage') this.recordCost(entry);
    this.message(entry);
  }

  visible(path) {
    if (!this.review) return true;

    if (!reviewVisibility(path, this.reviewParentId)) return false;
    this.name = 'Review awaiting parent publication';

    return true;
  }

  summary(path) {
    if (!this.header || !this.visible(path)) return;

    return { path, id: this.header.id || '', cwd: this.header.cwd || 'Unknown project', name: this.name || this.first || 'Untitled session', preview: this.preview, messageCount: this.count, lastMessageAt: this.lastMessageAt, apiCost: this.cost, explicitlyNamed: !!this.name, hasUserMessage: this.hasUserMessage, bytes: this.bytes, subagentParentId: this.ownSubagentParentId ?? this.subagentParentId };
  }
}

async function indexFile(path) {
  const index = new SessionIndex();
  let pending = [];

  for await (const chunk of fs.createReadStream(path)) {
    let start = 0, end;

    while ((end = chunk.indexOf(10, start)) >= 0) {
      pending.push(chunk.subarray(start, end));
      const line = Buffer.concat(pending);
      pending = []; start = end + 1;
      index.line(line);
    }

    if (start < chunk.length) pending.push(chunk.subarray(start));
  }

  if (pending.length) index.line(Buffer.concat(pending), false);

  return index.summary(path);
}

hostScript(async request => {
  if (!Array.isArray(request.paths) || !request.paths.every(path => typeof path === 'string')) throw new Error('Invalid session summary request');
  const summaries = [];

  for (const path of request.paths) {
    try {
      const summary = await indexFile(path);

      if (summary) summaries.push(summary);
    } catch (error) { console.error(`${path}: ${error.message}`); }
  }

  return summaries;
});
