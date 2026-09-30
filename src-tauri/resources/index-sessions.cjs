const fs = require('node:fs');

function text(message) {
  return typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
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
      if (entry.customType === 'piop-subagent-parent' && typeof data.parentSessionId === 'string') this.subagentParentId = data.parentSessionId;
      if (entry.customType === 'pi-desktop-resume' && typeof data.message === 'string') this.resumes.add(data.message);
    }
    if (entry.type === 'session_info' && entry.name?.trim()) this.name = entry.name.trim().slice(0, 2000);
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
      this.preview = [...content].slice(0, 100).join('');
    }
    if (message.role === 'assistant' || message.role === 'toolResult') this.recordCost(message);
  }

  recordCost(message) {
    const amount = message.usage?.cost?.total;
    if (Number.isFinite(amount) && amount >= 0) this.cost += amount;
  }

  line(line) {
    this.bytes += line.length + 1;
    let entry;
    try { entry = JSON.parse(line.toString('utf8')); } catch { return; }
    if (!this.header) {
      if (entry.type !== 'session') throw Error('Invalid session header');
      this.header = entry;
      return;
    }
    this.metadata(entry);
    if (entry.type === 'usage') this.recordCost(entry);
    this.message(entry);
  }

  print(path) {
    if (!this.header) return;
    console.log(JSON.stringify({ path, id: this.header.id || '', cwd: this.header.cwd || 'Unknown project', name: this.name || this.first || 'Untitled session', preview: this.preview, messageCount: this.count, lastMessageAt: this.lastMessageAt, apiCost: this.cost, explicitlyNamed: !!this.name, hasUserMessage: this.hasUserMessage, bytes: this.bytes, subagentParentId: this.subagentParentId }));
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
  index.print(path);
}

(async () => {
  for (const path of process.argv.slice(1)) {
    try { await indexFile(path); } catch (error) { console.error(`${path}: ${error.message}`); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
