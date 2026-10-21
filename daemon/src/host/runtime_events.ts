import { isObject, kind } from './json';

/** An event Pi sends from a lifecycle hook and waits on until Piop answers. name is the hook name, for example "task_success". */
export interface RuntimeEvent { id: string; name: string; data: Record<string, unknown> }

/** The chat whose Pi sent the event. */
export interface RuntimeEventSource { sessionKey: string; identity: string; cwd: string | null }

export function isRuntimeEvent(value: unknown): boolean { return kind(value) === 'piop_runtime_event'; }

export function parseRuntimeEvent(value: any): RuntimeEvent {
  if (typeof value?.id !== 'string' || !value.id) throw new Error('Runtime event has no ID');
  if (typeof value.name !== 'string' || !value.name) throw new Error('Runtime event ' + value.id + ' has no name');
  if (!isObject(value.data)) throw new Error('Runtime event ' + value.name + ' has no data');
  return { id: value.id, name: value.name, data: value.data };
}

export function runtimeEventResult(id: string, error?: string): any {
  return error === undefined ? { type: 'piop_runtime_event_result', id } : { type: 'piop_runtime_event_result', id, error };
}
