import { isObject, kind } from './json';

function utf16Length(value: string): number { return value.length; }

export function clientPayload(value: any): any {
  if (Array.isArray(value?.entries) && isObject(value) && Object.hasOwn(value, 'leafId')) return clientHistory(value);
  if (value?.role === 'toolResult') {
    value.content = '';
    value.deferredToolPayload = value.toolCallId ?? null;
    remove(value, ['details', 'toolInput', 'structuredContent', 'nestedCalls']);
  } else {
    value = clientToolPayload(value);
  }
  if (Array.isArray(value)) return value.map(clientPayload);
  if (isObject(value)) { for (const key of Object.keys(value)) value[key] = clientPayload(value[key]); }
  return value;
}

function remove(value: any, keys: string[]): void { if (isObject(value)) for (const key of keys) delete value[key]; }

function clientToolPayload(value: any): any {
  const name = kind(value);
  if (name === 'toolCall') {
    for (const key of Object.keys(value)) if (key !== 'type' && key !== 'id' && key !== 'name') delete value[key];
  } else if (name === 'toolcall_delta') remove(value, ['delta']);
  else if (name === 'toolcall_end' && isObject(value.toolCall)) value.toolCall = { id: value.toolCall.id ?? null, name: value.toolCall.name ?? null };
  else if (name.startsWith('tool_execution_')) deferToolResult(value);
  return value;
}

function deferToolResult(value: any): void {
  remove(value, ['args']);
  for (const field of ['result', 'partialResult']) {
    if (value[field] !== undefined && value[field] !== null) value[field] = { content: '', deferredToolPayload: value.toolCallId ?? null };
  }
}

export function branchEntries(history: any): any[] {
  const entries = new Map<string, any>();
  for (const entry of Array.isArray(history.entries) ? history.entries : []) if (typeof entry?.id === 'string') entries.set(entry.id, entry);
  const visited = new Set<string>();
  let cursor: unknown = history.leafId;
  const result: any[] = [];
  while (typeof cursor === 'string') {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const entry = entries.get(cursor);
    if (!entry) break;
    result.push(entry);
    cursor = entry.parentId;
  }
  return result.reverse();
}

function clientHistory(history: any): any {
  const inputs = new Map<string, any>();
  for (const entry of history.entries) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) if (kind(part) === 'toolCall' && typeof part.id === 'string') inputs.set(part.id, part.arguments ?? null);
  }
  const branch = branchEntries(history);
  const entries: any[] = [];
  let size = 0;
  let wireSize = 0;
  for (const original of [...branch].reverse()) {
    let entry = structuredClone(original);
    if (entry?.message?.role === 'toolResult') {
      const message = entry.message;
      const input = inputs.get(typeof message.toolCallId === 'string' ? message.toolCallId : '') ?? null;
      let patch: unknown = message.details?.patch;
      if (typeof patch !== 'string') {
        if (message.toolName === 'edit') patch = message.details?.diff;
        else if (message.toolName === 'apply_patch') patch = typeof input?.patch === 'string' ? input.patch : input?.input;
        else patch = undefined;
      }
      if (typeof patch === 'string' && utf16Length(patch) <= 2 * 1024 * 1024) {
        const diff: any = { patch };
        if (typeof input?.path === 'string') diff.path = input.path;
        message.toolDiff = diff;
      }
    }
    entry = clientPayload(entry);
    const serialized = JSON.stringify(entry);
    const cost = utf16Length(serialized) * 4 + 256;
    const bytes = Buffer.byteLength(serialized);
    if (size + cost > 256 * 1024 * 1024 || wireSize + bytes + 1 > 120 * 1024 * 1024) break;
    size += cost;
    wireSize += bytes + 1;
    entries.push(entry);
  }
  history.omittedEntries = branch.length - entries.length;
  history.entries = entries.reverse();
  return history;
}

export function savedToolPayload(entries: any[], id: string): any | undefined {
  const [input, result] = latestToolParts(entries, id);
  if (result === undefined && input === undefined) return undefined;
  const payload = result !== undefined ? structuredClone(result) : { content: '' };
  if (input !== undefined) payload.toolInput = structuredClone(input);
  return payload;
}

function latestToolParts(entries: any[], id: string): [any, any] {
  let call: any;
  let result: any;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.message;
    if (result === undefined && message?.role === 'toolResult' && message.toolCallId === id) result = message;
    if (call === undefined && Array.isArray(message?.content)) call = message.content.find((part: any) => kind(part) === 'toolCall' && part.id === id);
    if (result !== undefined && call !== undefined) break;
  }
  const input = call !== undefined && isObject(call) && Object.hasOwn(call, 'arguments') ? call.arguments : undefined;
  return [input, result];
}

export function assistantDelta(message: any, event: any): any {
  const index = event?.contentIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return message;
  if (index > 1_000_000 || !validDelta(event)) return message;
  if (!isObject(message)) message = {};
  if (!Array.isArray(message.content)) {
    const content = message.content;
    message.content = typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  }
  const content = message.content as any[];
  while (content.length < index + 1) content.push({ type: 'text', text: '' });
  if (kind(event).startsWith('toolcall_')) content[index] = toolDelta(content[index], event, index);
  else content[index] = textDelta(content[index], event);
  return message;
}

function validDelta(event: any): boolean {
  switch (kind(event)) {
    case 'text_start': case 'text_delta': case 'text_end': case 'thinking_start': case 'thinking_delta': case 'thinking_end': case 'toolcall_start': case 'toolcall_delta': return true;
    case 'toolcall_end': return isObject(event.toolCall);
    default: return false;
  }
}

function appendDelta(current: any, field: string, event: any): void {
  if (typeof current[field] !== 'string') current[field] = '';
  current[field] += typeof event.delta === 'string' ? event.delta : '';
}

function toolDelta(current: any, event: any, index: number): any {
  if (kind(current) !== 'toolCall') {
    current = { type: 'toolCall', id: Object.hasOwn(event, 'id') ? event.id : 'tool-' + index, name: Object.hasOwn(event, 'toolName') ? event.toolName : 'tool', arguments: {} };
  }
  switch (kind(event)) {
    case 'toolcall_start':
      return { type: 'toolCall', id: Object.hasOwn(event, 'id') ? event.id : current.id ?? null, name: Object.hasOwn(event, 'toolName') ? event.toolName : current.name ?? null, arguments: {}, partialArgs: '' };
    case 'toolcall_delta': appendDelta(current, 'partialArgs', event); return current;
    case 'toolcall_end': { const next = structuredClone(event.toolCall); next.type = 'toolCall'; return next; }
    default: return current;
  }
}

function textDelta(current: any, event: any): any {
  const name = kind(event);
  const split = name.indexOf('_');
  const field = name.slice(0, split);
  const action = name.slice(split + 1);
  if (!isObject(current)) current = {};
  if (action === 'start') return { type: field, [field]: '' };
  if (action === 'delta') {
    if (kind(current) !== field) current[field] = '';
    current.type = field;
    appendDelta(current, field, event);
    return current;
  }
  if (action === 'end') {
    current.type = field;
    current[field] = Object.hasOwn(event, 'content') ? event.content : '';
  }
  return current;
}
