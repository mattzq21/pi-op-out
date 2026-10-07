import type { ConversationDraft, createConversationDrafts } from "./appDrafts";
import type { NativeConnectionTarget, NativeTransport } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { AgentState, ComposerUpload, SessionSummary } from "./types";

type DraftBindingsContext = {
  owners: Map<NativeTransport, string>;
  transport: () => NativeTransport;
  state: () => AgentState;
  sessions: () => SessionSummary[];
  initialTarget: NativeConnectionTarget;
  initialKey: string;
};

function savedDraftTarget(owner: NativeTransport | undefined, context: DraftBindingsContext, known: SessionSummary | undefined, previous: NativeConnectionTarget) {
  if (known?.path) return { sessionId: known.id, sessionPath: known.path };

  if (owner === context.transport() && context.state().messageCount > 0) return { sessionId: context.state().sessionId, sessionPath: owner.currentSessionPath() };

  return { sessionId: previous.sessionId, sessionPath: previous.sessionPath };
}

function draftCwd(owner: NativeTransport | undefined, savedPath: string | undefined, known: SessionSummary | undefined, previous: NativeConnectionTarget) {
  if (!owner) return known?.cwd ?? previous.cwd;

  if (!savedPath && owner.isTemporaryChat()) return undefined;

  return owner.currentCwd() ?? previous.cwd;
}

function draftHost(owner: NativeTransport | undefined, known: SessionSummary | undefined, previous: NativeConnectionTarget) {
  return owner?.currentHostId() ?? known?.hostId ?? previous.hostId ?? "local";
}

export function createDraftBindings(drafts: ReturnType<typeof createConversationDrafts>, context: DraftBindingsContext) {
  const draftTargets = new Map<string, NativeConnectionTarget>();
  const fallbackTarget = (key: string) => key === context.initialKey ? context.initialTarget : draftKeyTarget(key);

  const keyForTransport = (owner: NativeTransport) => {
    const mapped = context.owners.get(owner);

    if (mapped) return mapped;
    const saved = context.sessions().find(session => (session.hostId ?? "local") === owner.currentHostId() && session.path && session.path === owner.currentSessionPath());
    const key = saved ? `${owner.currentHostId()}:${saved.id}` : `${owner.currentHostId()}:draft-${crypto.randomUUID()}`;
    context.owners.set(owner, key);

    return key;
  };

  const rememberDraftTarget = (key: string) => {
    const owner = [...context.owners].find(([, candidate]) => candidate === key)?.[0];
    const known = context.sessions().find(session => !session.isDraft && `${session.hostId ?? "local"}:${session.id}` === key);
    const previous = draftTargets.get(key) ?? drafts.records()[key]?.target ?? fallbackTarget(key);
    const hostId = draftHost(owner, known, previous);
    const saved = savedDraftTarget(owner, context, known, previous);
    const cwd = draftCwd(owner, saved.sessionPath, known, previous);
    const target = saved.sessionPath ? { hostId, cwd, ...saved } : { hostId, cwd, draftKey: key };

    if (JSON.stringify(draftTargets.get(key)) === JSON.stringify(target)) return;
    draftTargets.set(key, target); drafts.setDraftTarget(key, target);
  };

  const setComposerDraft = (key: string, update: StateUpdate<string>) => { rememberDraftTarget(key); drafts.setComposerDraft(key, update); };

  const setComposerUploads = (owner: NativeTransport, update: StateUpdate<ComposerUpload[]>) => { const key = keyForTransport(owner); rememberDraftTarget(key); drafts.setComposerUploads(key, update); };

  const transportHasDraft = (owner: NativeTransport, key = keyForTransport(owner)) => drafts.hasDraft(key);

  const uploadsByTransport = () => {
    drafts.records();

    return new Map([...context.owners].map(([owner, key]) => [owner, drafts.uploadsFor(key)]));
  };

  return { draftTargets, keyForTransport, rememberDraftTarget, setComposerDraft, setComposerUploads, transportHasDraft, uploadsByTransport };
}

export function draftKeyTarget(key: string): NativeConnectionTarget {
  const separator = key.lastIndexOf(":");

  return { hostId: separator < 0 ? "local" : key.slice(0, separator), draftKey: key };
}

export function restoredDraftSessions(records: Record<string, ConversationDraft>, saved: SessionSummary[]) {
  return Object.entries(records).flatMap(([key, draft]): SessionSummary[] => {
    if (saved.some(session => !session.isDraft && `${session.hostId ?? "local"}:${session.id}` === key)) return [];
    const target = draft.target ?? draftKeyTarget(key);
    const hostId = target.hostId ?? "local";
    const cwd = target.cwd ?? "";

    return [{ id: target.sessionId || key.slice(hostId.length + 1), hostId, isDraft: !target.sessionPath, path: target.sessionPath ?? "", cwd, project: cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace", name: draft.text.trim().slice(0, 60) || "Unsent draft", preview: draft.text, messageCount: 0, lastMessageAt: draft.updatedAt, apiCost: 0 }];
  });
}
