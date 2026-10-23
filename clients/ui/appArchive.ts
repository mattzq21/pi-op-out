import { batch, createSignal, type Accessor, type Setter } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { createRef, type RefObject } from "./lib/solid";
import type { useChatSession } from "./lib/useChatSession";
import type { SessionSummary } from "./types";
import { isTemporaryChatCwd } from "./lib/sessionGroups";
import { storageFailure } from "./lib/storageFailure";

type ArchiveContext = {
  reuseSessionDraft: () => boolean;
  runtimePool: Accessor<SessionRuntimePool>;
  transport: Accessor<NativeTransport>;
  chatSession: Accessor<ReturnType<typeof useChatSession>>;
  activeHostId: Accessor<string>;
  activeTransportRef: RefObject<NativeTransport>;
  activeConversationKeyRef: RefObject<string>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  isSelectedSession: (session: SessionSummary) => boolean;
  isSplitSession: (session: SessionSummary) => boolean;
  conversationTerminalIds: (key: string) => string[];
  removeConversationTerminals: (key: string) => void;
  removeDraft: (key: string) => void;
  removeSessionDrafts: (hostId: string, sessionPath?: string, sessionId?: string) => void;
  setSessions: Setter<SessionSummary[]>;
  setActiveCwd: Setter<string | undefined>;
  activateTransport: (transport: NativeTransport) => void;
  activateConversationKey: (key: string) => void;
  updateConnected: (connected: boolean) => void;
  closeSplitPane: () => void;
  syncSessionIndex: () => Promise<void>;
  addNotice: (notice: { title: string; message: string }) => void;
  archiveCount: { current: number };
};

function temporaryConversation(owner: NativeTransport, session: SessionSummary) {
  return owner.isTemporaryChat() || isTemporaryChatCwd(session.cwd);
}

export function createConversationArchive(context: ArchiveContext) {
  const { runtimePool, transport, chatSession, activeHostId, activeTransportRef, activeConversationKeyRef, transportConversationKeys, isSelectedSession, isSplitSession, conversationTerminalIds, removeConversationTerminals, removeDraft, setSessions, setActiveCwd, activateTransport, activateConversationKey, updateConnected, closeSplitPane, syncSessionIndex, addNotice } = context;
  const [archivePending, setArchivePending] = createSignal(new Set<string>());
  // Each archived key keeps the archive count at the time it was archived, so a session list loaded before the archive can not restore it.
  const archivedSessionKeys = createRef(new Map<string, number>());
  const { archiveCount } = context;
  const removalPending = new Set<string>();
  const ownsSelectedSession = (owner: NativeTransport, session: SessionSummary) => owner === transport() && isSelectedSession(session);
  const ownsConversationUi = (owner: NativeTransport, key: string) => activeTransportRef.current === owner && activeConversationKeyRef.current === key;

  const archiveTarget = (session: SessionSummary, key: string) => {
    if (archivePending().has(key)) return;

    if (session.isDraft || !session.path) {
      addNotice({ title: "Conversation is not saved yet", message: "Send a message before archiving this draft." });

      return;
    }

    return runtimePool().forSession(session);
  };

  const archiveSession = async (session: SessionSummary) => { const capturedRuntimePool = runtimePool(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const archivedSessionKey = `${session.hostId ?? "local"}:${session.id}`;
    const ownerTransport = archiveTarget(session, archivedSessionKey);

    if (!ownerTransport) return;
    setArchivePending(current => new Set(current).add(archivedSessionKey));
    const isActiveSession = ownsSelectedSession(ownerTransport, session);
    const splitSession = isSplitSession(session);
    const terminalIds = conversationTerminalIds(archivedSessionKey);

    const removeArchivedUi = () => {
      archivedSessionKeys.current.set(archivedSessionKey, ++archiveCount.current);
      setSessions((current) => current.filter((item) => item.path !== session.path || (item.hostId ?? "local") !== (session.hostId ?? "local")));
      removeDraft(archivedSessionKey);
      removeConversationTerminals(archivedSessionKey);
    };

    const recoverArchiveFailure = async (cause: unknown) => { if (isActiveSession && activeTransportRef.current === ownerTransport) { try { await ownerTransport.connect(); await capturedSession.refresh(); updateConnected(true); } catch { updateConnected(false); } }

    addNotice(storageFailure("archive", cause));

    void syncSessionIndex(); };

    const startTemporaryReplacement = async (hostId: string, conversationKey: string) => {
      const nextTransport = capturedRuntimePool.create({ hostId });
      transportConversationKeys.current.set(nextTransport, conversationKey);

      try {
        const cwd = await nextTransport.prepareTemporaryChat(hostId);

        if (!ownsConversationUi(ownerTransport, archivedSessionKey)) {
          transportConversationKeys.current.delete(nextTransport);
          void capturedRuntimePool.release(nextTransport);
        } else batch(() => { setActiveCwd(cwd); activateConversationKey(conversationKey); activateTransport(nextTransport); });

        await capturedRuntimePool.release(ownerTransport)
          .then(() => transportConversationKeys.current.delete(ownerTransport))
          .catch(reason => addNotice({ title: "Could not close archived conversation", message: reason instanceof Error ? reason.message : String(reason) }));
      } catch (reason) {
        transportConversationKeys.current.delete(nextTransport);
        void capturedRuntimePool.release(nextTransport);
        addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) });
        void syncSessionIndex();
      }
    };

    const connectArchiveReplacement = async (hostId: string, conversationKey: string) => {
      let replacementCwd = session.cwd || ownerTransport.currentCwd();
      const temporary = temporaryConversation(ownerTransport, session);

      if (replacementCwd && !temporary) {
        try { replacementCwd = await ownerTransport.validateProjectDirectory(replacementCwd, hostId, true); }
        catch { replacementCwd = undefined; }
      }

      if (!ownsConversationUi(ownerTransport, archivedSessionKey)) {
        await capturedRuntimePool.release(ownerTransport);
        transportConversationKeys.current.delete(ownerTransport);

        return;
      }

      if (!replacementCwd || temporary) return startTemporaryReplacement(hostId, conversationKey);

      try {
        const replacement = capturedRuntimePool.create({ cwd: replacementCwd, hostId });
        transportConversationKeys.current.set(replacement, conversationKey);
        batch(() => { setActiveCwd(replacementCwd); activateConversationKey(conversationKey); activateTransport(replacement); });
        await capturedRuntimePool.release(ownerTransport);
      } catch (reason) {
        addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) });
        void syncSessionIndex();
      }
    };

    const replaceArchivedConversation = async () => {
      if (context.reuseSessionDraft()) { await capturedRuntimePool.release(ownerTransport);

      return; }

      const hostId = capturedActiveHostId; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
      capturedSession.discardPendingUpdates(); capturedSession.setMessages([]);
      capturedSession.setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isPaused: false, isPausing: false, activity: undefined, contextUsage: undefined }));
      await connectArchiveReplacement(hostId, conversationKey);
    };

    try {
      if (splitSession) closeSplitPane();

      if (!isActiveSession) await capturedRuntimePool.remove(session);
      else { updateConnected(false); await ownerTransport.disconnect(); }

      await capturedTransport.archiveSession(session.path, session.hostId, terminalIds);
      removeArchivedUi();

      if (!isActiveSession) { await syncSessionIndex();

      return; }

      if (!ownsConversationUi(ownerTransport, archivedSessionKey)) { await capturedRuntimePool.remove(session); await syncSessionIndex();

      return; }

      await replaceArchivedConversation();
    } catch (reason) { await recoverArchiveFailure(reason); }
    finally { setArchivePending(current => { const next = new Set(current); next.delete(archivedSessionKey);

      return next; }); }

    return;
  };

  const selectedRemovedSession = (hostId: string, sessionPath: string | undefined, sessionId: string | undefined) => {
    const current = chatSession().state;

    return activeHostId() === hostId && (current.sessionId === sessionId || Boolean(sessionPath && current.sessionFile === sessionPath));
  };

  // The daemon stops the terminals of a removed conversation before it reports the removal.
  const forgetRemovedTerminals = (keys: Set<string>) => { for (const key of keys) removeConversationTerminals(key); };

  const replaceRemovedConversation = (pool: SessionRuntimePool, hostId: string) => {
    const previous = transport();

    if (context.reuseSessionDraft()) { void pool.release(previous);

    return; }

    const key = hostId + ":draft-" + crypto.randomUUID();
    const replacement = pool.create({ hostId });
    removeDraft(hostId + ":" + chatSession().state.sessionId);
    chatSession().discardPendingUpdates();
    transportConversationKeys.current.set(replacement, key);
    batch(() => {
      setActiveCwd(undefined); updateConnected(false);
      activateConversationKey(key); activateTransport(replacement);
    });
    void pool.release(previous).catch(reason => addNotice({ title: "Could not close archived conversation", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => transportConversationKeys.current.delete(previous));
  };

  const finishRemovedConversation = (pool: SessionRuntimePool, hostId: string, sessionPath: string | undefined, sessionId: string | undefined, summaries: SessionSummary[], id: string | undefined) => {
    context.removeSessionDrafts(hostId, sessionPath, sessionId ?? id);

    if (id) archivedSessionKeys.current.set(hostId + ":" + id, ++archiveCount.current);

    for (const session of summaries) {
      if (isSplitSession(session)) closeSplitPane();
      removeDraft(hostId + ":" + session.id);
    }

    if (selectedRemovedSession(hostId, sessionPath, sessionId)) replaceRemovedConversation(pool, hostId);

    for (const session of summaries) void pool.remove(session).catch(reason => addNotice({ title: "Could not close archived conversation", message: reason instanceof Error ? reason.message : String(reason) }));
  };

  return {
    archiveSession,
    removed: async (hostId: string, sessionPath: string | undefined, sessionId?: string) => {
      const pool = runtimePool();
      const matches = (session: SessionSummary) => (session.hostId ?? "local") === hostId && (session.id === sessionId || Boolean(sessionPath && session.path === sessionPath));
      const summaries = pool.liveSessionSummaries().filter(matches);
      const current = chatSession().state;
      const selected = selectedRemovedSession(hostId, sessionPath, sessionId);
      const id = sessionId ?? (selected ? current.sessionId : summaries[0]?.id);

      if (id && archivePending().has(`${hostId}:${id}`)) return true;
      const removalKey = `${hostId}:${id ?? sessionPath}`;

      if (removalPending.has(removalKey)) return false;
      removalPending.add(removalKey);

      try {
        const keys = new Set(summaries.map((session) => `${hostId}:${session.id}`));

        if (id) keys.add(`${hostId}:${id}`);

        forgetRemovedTerminals(keys);
        finishRemovedConversation(pool, hostId, sessionPath, sessionId, summaries, id);

        return true;
      } finally { removalPending.delete(removalKey); }
    },
    restored: (hostId: string, sessionId: string, listedAfter?: number) => {
      const key = `${hostId}:${sessionId}`;
      const archivedAt = archivedSessionKeys.current.get(key);

      if (archivedAt !== undefined && (listedAfter === undefined || archivedAt <= listedAfter)) archivedSessionKeys.current.delete(key);
    },
    isPending: (session: SessionSummary) => archivePending().has(`${session.hostId ?? "local"}:${session.id}`),
    isArchived: (session: SessionSummary) => archivedSessionKeys.current.has(`${session.hostId ?? "local"}:${session.id}`),
  };
}
