import * as stateRecords from '../../resources/piop-storage/index.ts';
import * as names from '../../resources/piop-storage/index.ts';
import fs from 'node:fs';
import { Type, type Static } from 'typebox';
import type { SessionHeader } from '@earendil-works/pi-coding-agent';
import { Check } from 'typebox/value';

const parentSchema = Type.Object({ kind: Type.String({ minLength: 1 }), parentSessionId: Type.String(), sessionId: Type.Optional(Type.String()) });

const entrySchema = Type.Object({ type: Type.String() });


const PREVIEW_CODE_POINTS = 100;

interface SessionEntry { type: string; id?: unknown; parentId?: unknown; message?: any; [key: string]: any }
interface IndexHeader extends SessionHeader { piopForkSource?: { sessionId?: unknown; entryId?: unknown } }
interface Auxiliary { parentId: string; kind: string }
interface MessageRecord { role: string; content: string; timestamp: number }
interface SessionSummary { path: string; id: string; cwd: string; name: string; preview: string; messageCount: number; lastMessageAt: number; apiCost: number; explicitlyNamed: boolean; hasUserMessage: boolean; bytes: number; auxiliaryParentId?: string; auxiliaryKind?: string; forkSourceId?: string; forkEntryId?: string }

function text(message: { content?: unknown }): string {
  return Check(Type.String(), message.content) ? message.content : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function userPrompt(content: string): string {
  const blocks = content.match(/^(?:\s*<skill\b[^>]*>[\s\S]*?<\/skill>\s*)+/)?.[0] ?? '';
  const rest = content.slice(blocks.length).trim();
  const missing = [...blocks.matchAll(/<skill\b[^>]*\bname="([^"]*)"/g)].map(match => match[1]).filter(name => !new RegExp(`(^|\\s)(\\$|/skill:)${escapeRegExp(name)}(?=\\s|$)`, 'i').test(rest));

  return [...missing.map(name => `$${name}`), rest].filter(Boolean).join(' ');
}

function timestamp(value: unknown): number {
  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value ?? ''));

  return Number.isFinite(parsed) ? parsed : 0;
}

class SessionIndex {
  header: IndexHeader | undefined;
  name: string | undefined;
  inheritedAuxiliary: Auxiliary | undefined;
  ownAuxiliary: Auxiliary | undefined;
  first = '';
  hasUserMessage = false;
  preview = '';
  count = 0;
  cost = 0;
  lastMessageAt = 0;
  bytes = 0;
  lineNumber = 0;
  damagedLines: number[] = [];
  interruptedBytes = 0;
  nodes = new Map<string, { parentId: string | null; record: MessageRecord | undefined }>();
  leaf: string | null = null;
  unnamed = 0;

  metadata(entry: SessionEntry) {
    if (entry.type === 'custom' && entry.customType === stateRecords.AUXILIARY_PARENT) {
      const data = entry.data ?? {};

      if (Check(parentSchema, data)) this.parent(data);
    }

  }

  parent(data: Static<typeof parentSchema>) {
    const header = this.header!;
    const own = data.sessionId === header.id;
    const unbound = data.sessionId === undefined && !header.parentSession;

    if (!own && !unbound) return;

    const auxiliary = { parentId: data.parentSessionId, kind: data.kind };

    if (own) this.ownAuxiliary = auxiliary;
    else this.inheritedAuxiliary = auxiliary;
  }

  messageRecord(entry: SessionEntry): MessageRecord | undefined {
    if (entry.type !== 'message') return undefined;
    const message = entry.message || {};
    let content = text(message);

    if (message.role === 'user') content = userPrompt(content);

    return { role: message.role, content: content.slice(0, 2000), timestamp: message.role === 'user' ? timestamp(message.timestamp ?? entry.timestamp) : 0 };
  }

  recordMessage(record: MessageRecord) {
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

  recordBranch() {
    const branch: (MessageRecord | undefined)[] = [];
    const seen = new Set<string>();

    for (let id = this.leaf, node; id !== null && (node = this.nodes.get(id)) && !seen.has(id); id = node.parentId) {
      seen.add(id);
      branch.push(node.record);
    }

    for (const record of branch.reverse()) if (record) this.recordMessage(record);
  }

  recordCost(message: { usage?: { cost?: { total?: unknown } }; [key: string]: unknown }) {
    const amount = message.usage?.cost?.total;

    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) this.cost += amount;
  }

  line(line: Buffer, terminated = true) {
    this.bytes += line.length + Number(terminated);
    this.lineNumber++;
    if (!terminated) { this.interruptedBytes = line.length; return; }
    let entry: SessionEntry;

    try { entry = JSON.parse(line.toString('utf8')); } catch { this.damagedLines.push(this.lineNumber); return; }

    if (!Check(entrySchema, entry)) { this.damagedLines.push(this.lineNumber); return; }

    if (!this.header) {
      if (entry.type !== 'session') throw Error('Invalid session header');
      this.header = entry as IndexHeader;

      return;
    }

    this.metadata(entry);
    if (stateRecords.isCurrent(entry) || stateRecords.isName(entry)) return;

    if (entry.type === 'usage') this.recordCost(entry);

    if (entry.type === 'message' && ['assistant', 'toolResult'].includes(entry.message?.role)) this.recordCost(entry.message);
    const id = typeof entry.id === 'string' ? entry.id : `#${++this.unnamed}`;
    const parentId = typeof entry.id !== 'string' ? this.leaf : typeof entry.parentId === 'string' ? entry.parentId : null;
    this.nodes.set(id, { parentId, record: this.messageRecord(entry) });
    this.leaf = id;
  }

  summary(path: string): SessionSummary | undefined {
    if (this.header) this.name = names.sessionName(path, this.header.id);
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
    if (!this.header) return;

    const source = this.header.piopForkSource;
    const sourceId = source?.sessionId, entryId = source?.entryId;
    const forked = typeof sourceId === 'string' && sourceId && typeof entryId === 'string' && entryId;
    const forkSourceId = forked ? sourceId : undefined;
    const forkEntryId = forked ? entryId : undefined;

    return { path, id: this.header.id || '', cwd: this.header.cwd || 'Unknown project', name: this.name ? names.capSessionName(this.name) : names.promptName(this.first) || 'Untitled session', preview: this.preview, messageCount: this.count, lastMessageAt: this.lastMessageAt, apiCost: this.cost, explicitlyNamed: !!this.name, hasUserMessage: this.hasUserMessage, bytes: this.bytes, auxiliaryParentId: (this.ownAuxiliary ?? this.inheritedAuxiliary)?.parentId, auxiliaryKind: (this.ownAuxiliary ?? this.inheritedAuxiliary)?.kind, forkSourceId, forkEntryId };
  }
}

async function indexFile(path: string) {
  const modifiedAt = Number(fs.statSync(path, { bigint: true }).mtimeNs / 1_000_000_000n);
  const index = new SessionIndex();
  let pending: Buffer[] = [];
  let state: Map<string | null, unknown[]> | undefined;
  const feed = (line: Buffer) => {
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

  const summary = index.summary(path);

  return summary && { ...summary, modifiedAt };
}

async function indexSessions(request: { paths: string[] }) {
  if (!Array.isArray(request.paths) || !request.paths.every((path: unknown) => typeof path === 'string')) throw new Error('Invalid session summary request');
  const summaries: SessionSummary[] = [];
  const warnings: string[] = [];

  for (const path of request.paths) {
    try {
      const summary = await indexFile(path);

      if (summary) summaries.push(summary);
    } catch (error) { warnings.push(`${path}: ${error.message}`); }
  }

  return { summaries, warnings };
}

export { indexSessions };
