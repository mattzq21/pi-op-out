import { z } from 'zod';
import { sessionSummarySchema } from '../../protocol/results';

export interface AgentAddress { hostId: string; sessionId?: string; sessionPath?: string; working: boolean; messageable: boolean }

export interface SessionSummary {
  id: string;
  auxiliaryParentId?: string;
  auxiliaryKind?: string;
  forkSourceId?: string;
  forkEntryId?: string;
  groupId: string | null;
  path: string;
  name: string;
  project: string;
  cwd: string;
  cwdExists: boolean;
  linkedWorktree?: boolean;
  worktreeRepository?: string;
  modifiedAt: number;
  preview: string;
  messageCount: number;
  lastMessageAt: number;
  apiCost: number;
  hostId: string;
  hostName: string;
}

export function serializeSession(session: SessionSummary): Record<string, unknown> {
  const result: Record<string, unknown> = { id: session.id };
  if (session.auxiliaryParentId !== undefined && session.auxiliaryKind !== undefined) Object.assign(result, { auxiliaryParentId: session.auxiliaryParentId, auxiliaryKind: session.auxiliaryKind });
  if (session.forkSourceId !== undefined && session.forkEntryId !== undefined) Object.assign(result, { forkSourceId: session.forkSourceId, forkEntryId: session.forkEntryId });
  Object.assign(result, {
    groupId: session.groupId ?? null, path: session.path, name: session.name, project: session.project, cwd: session.cwd, cwdExists: session.cwdExists,
    preview: session.preview, messageCount: session.messageCount, lastMessageAt: session.lastMessageAt, apiCost: session.apiCost, hostId: session.hostId, hostName: session.hostName,
  });
  if (session.linkedWorktree) result.linkedWorktree = true;
  if (session.worktreeRepository) result.worktreeRepository = session.worktreeRepository;
  return result;
}

// A chat of another host's list, checked against the shared schema.
export function parseSession(value: unknown): SessionSummary {
  const parsed = sessionSummarySchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid chat in a host list: ' + z.prettifyError(parsed.error));
  const session = parsed.data;
  if (session.cwdExists === undefined || session.hostId === undefined || session.hostName === undefined) throw new Error('Invalid chat in a host list: it has no host or folder state');
  const forked = Boolean(session.forkSourceId);
  if (forked && !session.forkEntryId) throw new Error('Invalid chat in a host list: a branch has no entry');
  return {
    id: session.id, auxiliaryParentId: session.auxiliaryParentId, auxiliaryKind: session.auxiliaryKind,
    forkSourceId: forked ? session.forkSourceId : undefined, forkEntryId: forked ? session.forkEntryId : undefined,
    groupId: session.groupId ?? null, path: session.path, name: session.name, project: session.project, cwd: session.cwd, cwdExists: session.cwdExists,
    modifiedAt: 0, preview: session.preview, messageCount: session.messageCount, lastMessageAt: session.lastMessageAt, apiCost: session.apiCost,
    hostId: session.hostId, hostName: session.hostName, linkedWorktree: session.linkedWorktree === true || undefined, worktreeRepository: session.worktreeRepository || undefined,
  };
}

export interface BlankSessionCleanup { path?: string; id?: string; submitted: boolean }
