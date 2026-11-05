import { createHash } from 'node:crypto';

const PAGE_UNITS = 524288;
const MAX_PAGE_UNITS = 2 * 1024 * 1024;
const CACHE_BYTES = 128 * 1024 * 1024;
const CACHE_ENTRIES = 32;

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

export class ToolPayload {
  readonly serialized: string;
  readonly revision: string;
  readonly length: number;

  constructor(message: any) {
    if (message === undefined || message === null) throw new Error('Tool input and output are not available yet');
    const content = message.content;
    const payload: any = { content: content === undefined || content === null ? '' : content };
    for (const key of ['details', 'toolInput', 'nestedCalls']) if (Object.hasOwn(message, key)) payload[key] = message[key] ?? null;
    this.serialized = JSON.stringify(payload);
    this.revision = createHash('sha256').update(this.serialized).digest('hex');
    this.length = this.serialized.length;
  }

  page(command: any): any {
    if (typeof command?.revision === 'string' && command.revision !== this.revision) throw new Error('Tool payload changed; reopen it to reload');
    let offset = 0;
    if (command?.offset !== undefined && command.offset !== null) {
      if (typeof command.offset !== 'number' || !Number.isInteger(command.offset) || command.offset < 0) throw new Error('Invalid output offset');
      offset = command.offset;
    }
    if (offset > this.length) throw new Error('Invalid output offset');
    let limit = PAGE_UNITS;
    if (command?.limit !== undefined && command.limit !== null) {
      if (typeof command.limit !== 'number' || !Number.isInteger(command.limit) || command.limit < 2) throw new Error('Invalid output page size');
      limit = command.limit;
    }
    limit = Math.min(limit, MAX_PAGE_UNITS);
    if (offset > 0 && offset < this.length && isLowSurrogate(this.serialized.charCodeAt(offset))) throw new Error('Invalid output offset');
    let end = Math.min(this.length, offset + limit);
    if (end < this.length && end > offset && isLowSurrogate(this.serialized.charCodeAt(end))) end -= 1;
    return { revision: this.revision, length: this.length, chunk: this.serialized.slice(offset, end) };
  }

  bytes(): number { return this.serialized.length * 2 + Math.ceil(this.serialized.length / 4096) * 16; }
}

interface CachedPayload { scope: string; sourceRevision: string; tool: string; payload: ToolPayload }

export class ToolPayloadCache {
  private entries: CachedPayload[] = [];

  get(scope: string, sourceRevision: string, tool: string): ToolPayload | undefined {
    const index = this.entries.findIndex(entry => entry.scope === scope && entry.sourceRevision === sourceRevision && entry.tool === tool);
    if (index < 0) return undefined;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry!);
    return entry!.payload;
  }

  insert(scope: string, sourceRevision: string, tool: string, payload: ToolPayload): void {
    const size = payload.bytes();
    if (size > CACHE_BYTES) return;
    this.entries = this.entries.filter(entry => entry.scope !== scope || entry.tool !== tool);
    let total = this.entries.reduce((sum, entry) => sum + entry.payload.bytes(), 0);
    while (this.entries.length >= CACHE_ENTRIES || total + size > CACHE_BYTES) {
      const entry = this.entries.shift();
      if (!entry) break;
      total -= entry.payload.bytes();
    }
    this.entries.push({ scope, sourceRevision, tool, payload });
  }
}
