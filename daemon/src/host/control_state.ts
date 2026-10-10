import { isObject } from './json';

export interface SavedControlState { isPaused: boolean; needsInput: boolean }

export function reduce(entries: any[], leafId: string | undefined | null): SavedControlState {
  let isPaused = false;
  const questions = new Map<string, boolean>();
  for (const entry of branch(entries, leafId)) {
    if (entry?.type !== 'custom') continue;
    const data = entry.data;
    if (entry.customType === 'pi-desktop-pause-state') isPaused = data?.isPaused === true;
    else if (entry.customType === 'piop-async-question') {
      const state = requestState(data);
      if (!state) throw new Error('Invalid saved asynchronous question request');
      questions.set(state[0], state[1]);
    }
  }
  return { isPaused, needsInput: [...questions.values()].some(resolved => !resolved) };
}

function present(data: any, key: string): boolean { return isObject(data) && Object.hasOwn(data, key); }

function requestState(data: any): [string, boolean] | undefined {
  if (typeof data?.id !== 'string' || !Array.isArray(data.questions)) return undefined;
  const valid = data.questions.every(validQuestion)
    && (!present(data, 'resolved') || typeof data.resolved === 'boolean')
    && (!present(data, 'answers') || validAnswers(data.answers))
    && (!present(data, 'queueId') || typeof data.queueId === 'string');
  return valid ? [data.id, data.resolved === true] : undefined;
}

function validQuestion(data: any): boolean { return typeof data?.title === 'string' && (!present(data, 'options') || stringArray(data.options)); }

function stringArray(data: any): boolean { return Array.isArray(data) && data.every(item => typeof item === 'string'); }

function validAnswers(data: any): boolean {
  if (!isObject(data)) return false;
  return Object.entries(data).filter(([key]) => !/[\n\r\u2028\u2029]/.test(key)).every(([, answer]: [string, any]) => stringArray(answer?.answers));
}

function branch(entries: any[], leafId: string | undefined | null): any[] {
  const byId = new Map<string, any>();
  for (const entry of entries) if (entry?.type !== 'session' && typeof entry?.id === 'string') byId.set(entry.id, entry);
  const seen = new Set<string>();
  let cursor: unknown = leafId;
  const result: any[] = [];
  while (typeof cursor === 'string' && cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    result.push(entry);
    cursor = entry.parentId;
  }
  return result.reverse();
}
