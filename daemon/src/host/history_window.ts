import { branchEntries } from './payload';

/** A chat opens with at least this many turns... */
const RECENT_TURNS = 5;
/** ...and at least this many characters of message text, whichever needs more history. */
const RECENT_TEXT = 5000;

const PROMPT_CONTEXTS = new Set(['piop-context', 'pi-desktop-prompt-context']);
const PROMPT_CUSTOM_MESSAGES = new Set(['piop-agent-message', 'piop-subagent-result']);

type History = { entries: any[]; leafId: string | null; before?: string | null; olderUsage?: any };

function role(entry: any): string | undefined { return entry?.type === 'message' ? entry.message?.role : undefined; }

/** User messages that resume a paused turn. They continue that turn. */
const resumes = new WeakSet<object>();

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
}

function branchOf(history: any): any[] {
  const branch = branchEntries(history);
  const markers = new Set<string>();
  for (const entry of branch) {
    if (entry?.type === 'custom' && entry.customType === 'pi-desktop-resume' && typeof entry.data?.message === 'string') markers.add(entry.data.message);
    else if (role(entry) === 'user' && markers.has(userText(entry.message.content))) resumes.add(entry);
  }
  return branch;
}

function startsTurn(entry: any): boolean {
  return (role(entry) === 'user' && !resumes.has(entry)) || (entry?.type === 'custom_message' && PROMPT_CUSTOM_MESSAGES.has(entry.customType));
}

function visibleText(entry: any): string {
  const content = entry?.type === 'message' ? entry.message?.content : entry?.type === 'custom_message' ? entry.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let result = '';
  for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') result += part.text;
  return result;
}

/** The index of the turn start where a view that ends before end begins. */
function windowStart(branch: any[], end: number): number {
  let turns = 0;
  let size = 0;
  for (let index = end - 1; index >= 0; index--) {
    if (role(branch[index]) !== 'toolResult') size += visibleText(branch[index]).length;
    if (startsTurn(branch[index]) && ++turns >= RECENT_TURNS && size >= RECENT_TEXT) return index;
  }
  return 0;
}

function isFinalResponse(entry: any): boolean {
  const message = entry?.type === 'message' ? entry.message : undefined;
  return message?.role === 'assistant' && (visibleText(entry).trim().length > 0 || message.stopReason === 'aborted' || message.stopReason === 'error');
}

function isWork(entry: any): boolean { const name = role(entry); return name === 'assistant' || name === 'toolResult'; }

function addUsage(total: any, usage: any): any {
  if (!usage || typeof usage !== 'object') return total;
  const next = { ...(total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }) };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) next[key] += Number.isFinite(usage[key]) ? usage[key] : 0;
  return next;
}

/** Replaces the work of a finished turn with a note on its final response. The client loads the work when the user opens it. */
function deferWork(turn: any[]): any[] {
  let final = -1;
  for (let index = turn.length - 1; index >= 0; index--) if (isFinalResponse(turn[index])) { final = index; break; }
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

/** Fills the first prompt context of a view with the system prompt and tools that it shares with an earlier, omitted context. */
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

/** Links the entries of a view in order, so the client reads them as one branch. */
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

/** The newest part of a chat's history that the client shows when it opens the chat. */
export function recentHistory(history: any, working: boolean): any {
  const branch = branchOf(history);
  return Object.assign(history, view(branch, windowStart(branch, branch.length), branch.length, working));
}

function position(branch: any[], id: unknown): number {
  const index = typeof id === 'string' ? branch.findIndex(entry => entry?.id === id) : -1;
  if (index < 0) throw new Error('This part of the chat is no longer on its branch; reopen the chat');
  return index;
}

/** The part of the history just before the entry before. */
export function olderHistory(history: any, before: unknown): History {
  const branch = branchOf(history);
  const end = position(branch, before);
  return view(branch, windowStart(branch, end), end, false);
}

/** The work and full final response of the turn whose final response is entry id. */
export function turnWork(history: any, id: unknown): History {
  const branch = branchOf(history);
  const final = position(branch, id);
  let start = final;
  while (start > 0 && !startsTurn(branch[start])) start--;
  let end = final + 1;
  while (end < branch.length && !startsTurn(branch[end])) end++;
  return linked(branch.slice(start, end).filter(isWork), null);
}
