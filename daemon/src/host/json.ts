import { isDeepStrictEqual } from 'node:util';

export type Json = any;

export function kind(value: Json): string { return typeof value?.type === 'string' ? value.type : ''; }
export function text(value: Json, field: string): string { const item = value?.[field]; return typeof item === 'string' ? item : ''; }
export function flag(value: Json, field: string): boolean { return value?.[field] === true; }
export function array(value: Json, field: string): Json[] { const item = value?.[field]; return Array.isArray(item) ? [...item] : []; }
export function has(value: Json, field: string): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, field) && value[field] !== undefined; }
export function str(value: Json): string | undefined { return typeof value === 'string' ? value : undefined; }
export function nz(value: Json): Json { return value === undefined ? null : value; }
export function isObject(value: Json): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function u64(value: Json): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined; }
export function clone<T>(value: T): T { return value === undefined ? value : structuredClone(value); }

function normalize(value: Json): Json {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) result[key] = normalize(value[key]);
    return result;
  }
  return value;
}

/** Compares two JSON values the way serde_json compares Value (missing equals null at the top level). */
export function jsonEqual(left: Json, right: Json): boolean { return isDeepStrictEqual(normalize(left), normalize(right)); }

/** Serializes a JSON value with sorted keys, so equal values give equal text. */
export function canon(value: Json): string { return JSON.stringify(normalize(value)); }

export function messageText(content: Json, separator: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => kind(part) === 'text' && typeof part.text === 'string').map(part => part.text).join(separator);
}

export function merge(target: Json, source: Json): void {
  if (isObject(target) && isObject(source)) Object.assign(target, source);
}

export function setEntry<T>(items: Array<[string, T]>, key: string, value: T): void {
  const found = items.find(([id]) => id === key);
  if (found) found[1] = value; else items.push([key, value]);
}

export function take(value: Json, field: string): Json {
  if (!isObject(value) || !Object.hasOwn(value, field)) return null;
  const item = value[field];
  value[field] = null;
  return nz(item);
}

export function fail(message: string): never { throw new Error(message); }

/** Holds cleanup actions that run when an operation is abandoned, the way dropping a Rust future runs destructors. */
export class CancelScope {
  cancelled = false;
  private actions = new Set<() => void>();
  add(action: () => void): void { if (this.cancelled) action(); else this.actions.add(action); }
  remove(action: () => void): void { this.actions.delete(action); }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const action of [...this.actions]) { try { action(); } catch {} }
    this.actions.clear();
  }
}
