export interface AgentAddress { hostId: string; sessionId?: string; sessionPath?: string; working: boolean; messageable: boolean }

export interface SessionSummary {
  id: string;
  /** The root or auxiliary session that owns this auxiliary session. */
  auxiliaryParentId?: string;
  /** What kind of auxiliary session this is, for example "subagent", "review" or "btw". */
  auxiliaryKind?: string;
  /** The conversation this one was branched from, on the same machine. */
  forkSourceId?: string;
  groupId: string | null;
  path: string;
  name: string;
  project: string;
  cwd: string;
  cwdExists: boolean;
  /** True when the folder is a linked Git worktree, not the main worktree of its repository. */
  linkedWorktree?: boolean;
  /** The main worktree folder of the repository, when the chat works in a worktree that Piop created for it. */
  worktreeRepository?: string;
  /** Not sent to clients. */
  modifiedAt: number;
  preview: string;
  messageCount: number;
  lastMessageAt: number;
  apiCost: number;
  hostId: string;
  hostName: string;
}

/** Serializes a session summary in the client field order, without modifiedAt. */
export function serializeSession(session: SessionSummary): Record<string, unknown> {
  const result: Record<string, unknown> = { id: session.id };
  if (session.auxiliaryParentId !== undefined && session.auxiliaryKind !== undefined) Object.assign(result, { auxiliaryParentId: session.auxiliaryParentId, auxiliaryKind: session.auxiliaryKind });
  if (session.forkSourceId !== undefined) result.forkSourceId = session.forkSourceId;
  Object.assign(result, {
    groupId: session.groupId ?? null, path: session.path, name: session.name, project: session.project, cwd: session.cwd, cwdExists: session.cwdExists,
    preview: session.preview, messageCount: session.messageCount, lastMessageAt: session.lastMessageAt, apiCost: session.apiCost, hostId: session.hostId, hostName: session.hostName,
  });
  if (session.linkedWorktree) result.linkedWorktree = true;
  if (session.worktreeRepository) result.worktreeRepository = session.worktreeRepository;
  return result;
}

/** Reads a session summary from its client form. A missing modifiedAt becomes 0. */
export function parseSession(value: any): SessionSummary {
  const text = (key: string): string => { if (typeof value?.[key] !== 'string') throw new Error(`missing field \`${key}\``); return value[key]; };
  const number = (key: string): number => { if (typeof value?.[key] !== 'number') throw new Error(`missing field \`${key}\``); return value[key]; };
  if (typeof value?.cwdExists !== 'boolean') throw new Error('missing field `cwdExists`');
  return {
    id: text('id'), auxiliaryParentId: typeof value.auxiliaryParentId === 'string' ? value.auxiliaryParentId : undefined, auxiliaryKind: typeof value.auxiliaryKind === 'string' ? value.auxiliaryKind : undefined,
    forkSourceId: typeof value.forkSourceId === 'string' && value.forkSourceId ? value.forkSourceId : undefined,
    groupId: typeof value.groupId === 'string' ? value.groupId : null, path: text('path'), name: text('name'), project: text('project'), cwd: text('cwd'),
    cwdExists: value.cwdExists, modifiedAt: 0, preview: text('preview'), messageCount: number('messageCount'), lastMessageAt: number('lastMessageAt'),
    apiCost: number('apiCost'), hostId: text('hostId'), hostName: text('hostName'), linkedWorktree: value.linkedWorktree === true || undefined,
    worktreeRepository: typeof value.worktreeRepository === 'string' && value.worktreeRepository ? value.worktreeRepository : undefined,
  };
}

export interface BlankSessionCleanup { path?: string; id?: string; submitted: boolean }
