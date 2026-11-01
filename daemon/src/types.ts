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

export function parseSession(value: any): SessionSummary {
  const text = (key: string): string => { if (typeof value?.[key] !== 'string') throw new Error(`missing field \`${key}\``); return value[key]; };
  const number = (key: string): number => { if (typeof value?.[key] !== 'number') throw new Error(`missing field \`${key}\``); return value[key]; };
  if (typeof value?.cwdExists !== 'boolean') throw new Error('missing field `cwdExists`');
  const forked = typeof value.forkSourceId === 'string' && value.forkSourceId;
  if (forked && !(typeof value.forkEntryId === 'string' && value.forkEntryId)) throw new Error('missing field `forkEntryId`');
  return {
    id: text('id'), auxiliaryParentId: typeof value.auxiliaryParentId === 'string' ? value.auxiliaryParentId : undefined, auxiliaryKind: typeof value.auxiliaryKind === 'string' ? value.auxiliaryKind : undefined,
    forkSourceId: forked ? value.forkSourceId : undefined, forkEntryId: forked ? value.forkEntryId : undefined,
    groupId: typeof value.groupId === 'string' ? value.groupId : null, path: text('path'), name: text('name'), project: text('project'), cwd: text('cwd'),
    cwdExists: value.cwdExists, modifiedAt: 0, preview: text('preview'), messageCount: number('messageCount'), lastMessageAt: number('lastMessageAt'),
    apiCost: number('apiCost'), hostId: text('hostId'), hostName: text('hostName'), linkedWorktree: value.linkedWorktree === true || undefined,
    worktreeRepository: typeof value.worktreeRepository === 'string' && value.worktreeRepository ? value.worktreeRepository : undefined,
  };
}

export interface BlankSessionCleanup { path?: string; id?: string; submitted: boolean }
