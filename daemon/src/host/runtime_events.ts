import { isObject, kind } from './json';

export interface RuntimeEvent { id: string; name: string; data: Record<string, unknown> }

export interface RuntimeEventSource { sessionKey: string; identity: string; cwd: string | null }

export function isRuntimeEvent(value: unknown): boolean { return kind(value) === 'piop_runtime_event'; }

export function parseRuntimeEvent(value: any): RuntimeEvent {
  if (typeof value?.id !== 'string' || !value.id) throw new Error('Runtime event has no ID');
  if (typeof value.name !== 'string' || !value.name) throw new Error('Runtime event ' + value.id + ' has no name');
  if (!isObject(value.data)) throw new Error('Runtime event ' + value.name + ' has no data');
  return { id: value.id, name: value.name, data: value.data };
}

export function runtimeEventResult(id: string, error?: string, data?: unknown): any {
  if (error !== undefined) return { type: 'piop_runtime_event_result', id, error };
  return data === undefined ? { type: 'piop_runtime_event_result', id } : { type: 'piop_runtime_event_result', id, data };
}
