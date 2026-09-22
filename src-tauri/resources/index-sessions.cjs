const fs = require('node:fs');

function text(message) {
  return typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
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
    const voice = entry.type === 'custom' && entry.customType === 'piop-voice' ? entry.data : undefined;
    if (entry.type !== 'message' && !voice) return;
    const message = voice ? { role: voice.role, content: voice.text } : entry.message || {};
    const content = text(message).replace(/^\[Voice request [a-f0-9-]{36}; answer concisely\]\n/, '');
    if (message.role === 'user' && this.resumes.has(content)) return;
    this.recordMessage(message, content, voice, entry);
  }

  recordMessage(message, content, voice, entry) {
    // Sidebar recency follows prompts, not later assistant/tool activity.
    if (message.role === 'user') this.lastMessageAt = Math.max(this.lastMessageAt, timestamp(voice?.startMs ?? message.timestamp ?? entry.timestamp));
    this.count++;
    if (content) {
      if (!this.first && message.role === 'user') this.first = content.slice(0, 2000);
      this.preview = [...content].slice(0, 100).join('');
    }
    this.recordCost(message);
  }

  recordCost(message) {
    const amount = message.usage?.cost?.total;
    if (message.role === 'assistant' && Number.isFinite(amount) && amount >= 0) this.cost += amount;
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
    this.message(entry);
  }

  print(path) {
    if (!this.header) return;
    console.log(JSON.stringify({ path, id: this.header.id || '', cwd: this.header.cwd || 'Unknown project', name: this.name || this.first || 'Untitled session', preview: this.preview, messageCount: this.count, lastMessageAt: this.lastMessageAt, apiCost: this.cost, explicitlyNamed: !!this.name, hasUserMessage: !!this.first, bytes: this.bytes, subagentParentId: this.subagentParentId }));
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
