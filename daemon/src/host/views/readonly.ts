import { kind, text } from './json';
import { ownershipError } from './ownership';
import { savedToolPayload } from './payload';
import { historyOutline, olderHistory, recentHistory, turnWork } from './history_window';
import { ToolPayload } from './tool_payload';
import type { Host } from './controller';

export interface ReadonlyView { id: string; path: string | null }

const READ_COMMANDS = ['get_snapshot', 'get_entries', 'get_state', 'get_session_revision', 'get_tool_payload', 'get_session_stats', 'get_older_history', 'get_history_outline', 'get_turn_work'];

// A command from a view that does not own its conversation: only reads are allowed.
export async function readonlyCommand(host: Host, command: any, target: ReadonlyView): Promise<any> {
  if (!READ_COMMANDS.includes(kind(command))) throw new Error(ownershipError());
  const session = host.findSession(target.id);
  if (session && !session.transient()) return session.execute(structuredClone(command));
  if (host.ownership().lookupSaved(target.id, true) === null) {
    if (host.ownership().removed(target.id)) {
      host.events.sessionRemoved(target.id, target.path);
      throw new Error('This conversation has been deleted or archived');
    }
    throw new Error('Conversation storage is temporarily unavailable; try again');
  }
  return readSavedConversation(host, target, command);
}

export function readonlyPresence(host: Host, runtime: string, presence: unknown, target: ReadonlyView): null {
  host.findSession(target.id)?.presence(runtime, structuredClone(presence ?? null));
  return null;
}

export function announceRemoved(host: Host, id: string): void {
  const path = host.views.readonlyPath(id);
  if (path === undefined) return;
  host.events.sessionRemoved(id, path);
}

export async function detachReadonly(host: Host, runtime: string, target: ReadonlyView): Promise<any> {
  const session = host.views.forget(runtime) ?? host.findSession(target.id);
  if (session) {
    session.detachView(runtime);
    await session.finishDetach(false, true);
    await host.releaseUnused(session);
  }
  return { stopped: false };
}

function readSavedConversation(host: Host, target: ReadonlyView, command: any): any {
  if (kind(command) === 'get_session_revision') return host.ownership().revision(target.id, target.path);
  if (kind(command) === 'get_tool_payload') return readSavedToolPayload(host, target, command);
  const snapshot = host.ownership().snapshot(target.id, target.path);
  switch (kind(command)) {
    case 'get_snapshot': if (command.recent === true && snapshot.history) recentHistory(snapshot.history, false, command.listedBefore); return snapshot;
    case 'get_older_history': return olderHistory(snapshot.history ?? {}, command.before, command.through);
    case 'get_history_outline': return historyOutline(snapshot.history ?? {}, command.before);
    case 'get_turn_work': return turnWork(snapshot.history ?? {}, command.entryId);
    case 'get_entries': return snapshot.history ?? null;
    case 'get_state': return snapshot.state ?? null;
    case 'get_session_stats': return { contextUsage: snapshot.state?.contextUsage ?? null };
    default: throw new Error('Unsupported saved conversation command');
  }
}

function readSavedToolPayload(host: Host, target: ReadonlyView, command: any): any {
  const scope = 'saved:' + target.id;
  const id = text(command, 'toolCallId');
  const revision = host.ownership().revision(target.id, target.path);
  const cached = host.toolPayloads.get(scope, text(revision, 'revision'), id);
  if (cached) return cached.page(command);
  const snapshot = host.ownership().snapshot(target.id, target.path);
  const entries = Array.isArray(snapshot.history?.entries) ? snapshot.history.entries : [];
  const payload = new ToolPayload(savedToolPayload(entries, id) ?? null);
  const page = payload.page(command);
  host.toolPayloads.insert(scope, text(snapshot, 'revision'), id, payload);
  return page;
}
