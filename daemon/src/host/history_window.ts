import { branchEntries } from './payload';

const RECENT_TURNS = 5;
const RECENT_TEXT = 5000;

const PROMPT_CONTEXTS = new Set(['piop-context', 'pi-desktop-prompt-context']);
const PROMPT_CUSTOM_MESSAGES = new Set(['piop-agent-message', 'piop-subagent-result', 'piop-goal-context']);

type History = { entries: any[]; leafId: string | null; before?: string | null; olderUsage?: any };

function role(entry: any): string | undefined { return entry?.type === 'message' ? entry.message?.role : undefined; }

function startsTurn(entry: any): boolean {
  return role(entry) === 'user' || (entry?.type === 'custom_message' && PROMPT_CUSTOM_MESSAGES.has(entry.customType));
}

function visibleText(entry: any): string {
  const content = entry?.type === 'message' ? entry.message?.content : entry?.type === 'custom_message' ? entry.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let result = '';
  for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') result += part.text;
  return result;
}

function windowStart(branch: any[], end: number): number {
  let turns = 0;
  let size = 0;
  for (let index = end - 1; index >= 0; index--) {
    if (role(branch[index]) !== 'toolResult') size += visibleText(branch[index]).length;
    if (startsTurn(branch[index]) && ++turns >= RECENT_TURNS && size >= RECENT_TEXT) return index;
  }
  return 0;
}

function finalResponse(turn: any[]): number {
  for (let index = turn.length - 1; index >= 0; index--) {
    const message = turn[index]?.type === 'message' ? turn[index].message : undefined;
    if (message?.role !== 'assistant') continue;
    if (message.stopReason === 'aborted' || message.stopReason === 'error') return index;
    if (Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'toolCall')) return -1;
    if (message.stopReason === 'stop' || visibleText(turn[index]).trim().length > 0) return index;
  }
  return -1;
}

function isWork(entry: any): boolean { const name = role(entry); return name === 'assistant' || name === 'toolResult'; }

function addUsage(total: any, usage: any): any {
  if (!usage || typeof usage !== 'object') return total;
  const next = { ...(total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }) };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) next[key] += Number.isFinite(usage[key]) ? usage[key] : 0;
  return next;
}

function deferWork(turn: any[]): any[] {
  const final = finalResponse(turn);
  if (final < 0) return turn;
  const work = turn.filter((entry, index) => index !== final && isWork(entry));
  const content = turn[final].message.content;
  const parts = Array.isArray(content) ? content.filter((part: any) => part?.type === 'text') : content;
  const reasoning = Array.isArray(content) && content.some((part: any) => part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim());
  if (!work.length && !reasoning) return turn;
  let usage: any;
  for (const entry of work) if (role(entry) === 'assistant') usage = addUsage(usage, entry.message.usage);
  const first = turn.find(entry => role(entry) === 'assistant');
  const deferredWork: any = { reasoningOnly: work.length === 0 };
  if (usage) deferredWork.usage = usage;
  if (first !== turn[final] && first?.message?.usage) deferredWork.firstUsage = first.message.usage;
  const response = { ...turn[final], message: { ...turn[final].message, content: parts, deferredWork } };
  return turn.flatMap((entry, index) => index === final ? [response] : isWork(entry) ? [] : [entry]);
}

function resolvePromptContext(branch: any[], start: number, entries: any[]): void {
  if (start === 0) return;
  let systemPrompt: unknown;
  let tools: unknown;
  for (let index = 0; index < start; index++) {
    const entry = branch[index];
    if (entry?.type !== 'custom' || !PROMPT_CONTEXTS.has(entry.customType) || !entry.data || typeof entry.data !== 'object') continue;
    if (!entry.data.sameAsPrevious?.systemPrompt) systemPrompt = entry.data.systemPrompt;
    if (!entry.data.sameAsPrevious?.tools) tools = entry.data.tools;
  }
  const index = entries.findIndex(entry => entry?.type === 'custom' && PROMPT_CONTEXTS.has(entry.customType) && entry.data && typeof entry.data === 'object');
  if (index < 0) return;
  const { sameAsPrevious, ...data } = entries[index].data;
  data.systemPrompt = sameAsPrevious?.systemPrompt ? systemPrompt : data.systemPrompt;
  data.tools = sameAsPrevious?.tools ? tools : data.tools;
  entries[index] = { ...entries[index], data };
}

function linked(entries: any[], before: string | null): History {
  let parentId: string | null = null;
  const result = entries.map(entry => { const next = { ...entry, parentId }; parentId = entry.id; return next; });
  return { entries: result, leafId: parentId, before };
}

function view(branch: any[], start: number, end: number, keepLastTurn: boolean): History {
  const entries: any[] = [];
  let turn: any[] = [];
  const close = (last: boolean) => { entries.push(...(last && keepLastTurn ? turn : deferWork(turn))); turn = []; };
  for (let index = start; index < end; index++) {
    if (startsTurn(branch[index]) && turn.length) close(false);
    turn.push(branch[index]);
  }
  close(true);
  resolvePromptContext(branch, start, entries);
  const result = linked(entries, start > 0 ? branch[start].id : null);
  let usage: any;
  for (let index = 0; index < start; index++) if (role(branch[index]) === 'assistant') usage = addUsage(usage, branch[index].message.usage);
  if (usage) result.olderUsage = usage;
  return result;
}

export function recentHistory(history: any, working: boolean, listedBefore?: unknown): any {
  const branch = branchEntries(history);
  const start = windowStart(branch, branch.length);
  const result = view(branch, start, branch.length, working);
  return Object.assign(history, result, start > 0 && branch[start].id !== listedBefore ? { outline: outline(branch, start) } : {});
}

function position(branch: any[], id: unknown): number {
  const index = typeof id === 'string' ? branch.findIndex(entry => entry?.id === id) : -1;
  if (index < 0) throw new Error('This part of the chat is no longer on its branch; reopen the chat');
  return index;
}

function turnStart(branch: any[], index: number): number {
  while (index > 0 && !startsTurn(branch[index])) index--;
  return index;
}

export function olderHistory(history: any, before: unknown, through?: unknown): History {
  const branch = branchEntries(history);
  const end = position(branch, before);
  let start = windowStart(branch, end);
  if (through !== undefined) {
    const target = position(branch, through);
    if (target >= end) throw new Error('The entry is not in the older history');
    start = Math.min(start, turnStart(branch, target));
  }
  return view(branch, start, end, false);
}

const PREVIEW_LENGTH = 160;

type OutlineResponse = { id: string; start: string; preview: string; compactions?: string[] };

function outline(branch: any[], end: number): OutlineResponse[] {
  const responses: OutlineResponse[] = [];
  let turn: any[] = [];
  const close = () => {
    const final = finalResponse(turn);
    if (final >= 0) {
      const entry = turn[final];
      const preview = visibleText(entry).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH) || (entry.message.stopReason === 'stop' ? 'Empty response' : 'Response interrupted');
      const compactions = turn.filter(item => item?.type === 'compaction').map(item => item.id);
      responses.push({ id: entry.id, start: turn[0].id, preview, ...(compactions.length ? { compactions } : {}) });
    }
    turn = [];
  };
  for (let index = 0; index < end; index++) {
    if (startsTurn(branch[index]) && turn.length) close();
    turn.push(branch[index]);
  }
  close();
  return responses;
}

export function historyOutline(history: any, before: unknown): { responses: OutlineResponse[] } {
  const branch = branchEntries(history);
  return { responses: outline(branch, position(branch, before)) };
}

export function turnWork(history: any, id: unknown): History {
  const branch = branchEntries(history);
  const final = position(branch, id);
  let start = final;
  while (start > 0 && !startsTurn(branch[start])) start--;
  let end = final + 1;
  while (end < branch.length && !startsTurn(branch[end])) end++;
  return linked(branch.slice(start, end).filter(entry => isWork(entry) || entry?.type === 'compaction'), null);
}
