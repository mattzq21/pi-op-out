import { batch, createSignal, type Accessor, type Setter } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { createRef, type RefObject } from "./lib/solid";
import type { useChatSession } from "./lib/useChatSession";
import type { SessionSummary } from "./types";
import { isTemporaryChatCwd } from "./lib/sessionGroups";

type ArchiveContext = {
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
  setSessions: Setter<SessionSummary[]>;
  setActiveCwd: Setter<string | undefined>;
  activateTransport: (transport: NativeTransport) => void;
  activateConversationKey: (key: string) => void;
  updateConnected: (connected: boolean) => void;
  closeSplitPane: () => void;
  syncSessionIndex: () => Promise<void>;
  addNotice: (notice: { title: string; message: string }) => void;
};

export function createConversationArchive(context: ArchiveContext) {
  const { runtimePool, transport, chatSession, activeHostId, activeTransportRef, activeConversationKeyRef, transportConversationKeys, isSelectedSession, isSplitSession, conversationTerminalIds, removeConversationTerminals, removeDraft, setSessions, setActiveCwd, activateTransport, activateConversationKey, updateConnected, closeSplitPane, syncSessionIndex, addNotice } = context;
  const [archivePending, setArchivePending] = createSignal(new Set<string>());
  const archivedSessionKeys = createRef(new Set<string>());
  const removalPending = new Set<string>();
  const ownsSelectedSession = (owner: NativeTransport, session: SessionSummary) => owner === transport() && isSelectedSession(session);
  const ownsConversationUi = (owner: NativeTransport, key: string) => activeTransportRef.current === owner && activeConversationKeyRef.current === key;

  const archiveTarget = (session: SessionSummary, key: string, confirm: boolean) => {
    if (archivePending().has(key)) return;

    if (session.isDraft || !session.path) {
      addNotice({ title: "Conversation is not saved yet", message: "Send a message before archiving this draft." });

      return;
    }

    const ownerTransport = runtimePool().forSession(session);

    if (ownerTransport.isEphemeral()) {
      addNotice({ title: "Temporary conversation", message: "Temporary side conversations cannot be archived." });

      return;
    }

    if (confirm && !window.confirm(`Archive “${session.name}”?`)) return;

    return ownerTransport;
  };

  const archiveSession = async (session: SessionSummary, confirm = true) => { const capturedRuntimePool = runtimePool(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const archivedSessionKey = `${session.hostId ?? "local"}:${session.id}`;
    const ownerTransport = archiveTarget(session, archivedSessionKey, confirm);

    if (!ownerTransport) return;
    setArchivePending(current => new Set(current).add(archivedSessionKey));
    const isActiveSession = ownsSelectedSession(ownerTransport, session);
    const splitSession = isSplitSession(session);
    const terminalIds = conversationTerminalIds(archivedSessionKey);

    const removeArchivedUi = () => {
      archivedSessionKeys.current.add(archivedSessionKey);
      setSessions((current) => current.filter((item) => item.path !== session.path || (item.hostId ?? "local") !== (session.hostId ?? "local")));
      removeDraft(archivedSessionKey);
      removeConversationTerminals(archivedSessionKey);
    };

    const recoverArchiveFailure = async (cause: unknown) => { if (isActiveSession && activeTransportRef.current === ownerTransport) { try { await ownerTransport.connect(); await capturedSession.refresh(); updateConnected(true); } catch { updateConnected(false); } }

    addNotice({ title: "Could not archive conversation", message: cause instanceof Error ? cause.message : String(cause) }); };

    const connectArchiveReplacement = async (hostId: string, conversationKey: string) => {
      if (ownerTransport.isTemporaryChat() || isTemporaryChatCwd(session.cwd)) {
        const nextTransport = capturedRuntimePool.create({ hostId }); transportConversationKeys.current.set(nextTransport, conversationKey);

        try {
          const cwd = await nextTransport.prepareTemporaryChat(hostId);

          if (activeTransportRef.current !== ownerTransport || activeConversationKeyRef.current !== conversationKey) { transportConversationKeys.current.delete(nextTransport); void capturedRuntimePool.release(nextTransport); void capturedRuntimePool.release(ownerTransport).finally(() => transportConversationKeys.current.delete(ownerTransport)); }
          else { setActiveCwd(cwd); activateTransport(nextTransport); void capturedRuntimePool.release(ownerTransport).finally(() => transportConversationKeys.current.delete(ownerTransport)); }
        } catch (reason) {
          transportConversationKeys.current.delete(nextTransport); void capturedRuntimePool.release(nextTransport);
          addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex();
        }
      } else try { const replacement = capturedRuntimePool.create({ cwd: session.projectRoot || ownerTransport.currentCwd(), hostId }); transportConversationKeys.current.set(replacement, conversationKey); activateTransport(replacement); await capturedRuntimePool.release(ownerTransport); }
      catch (reason) { addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex(); }
    };

    const replaceArchivedConversation = async () => {
      const hostId = capturedActiveHostId; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
      transportConversationKeys.current.set(capturedTransport, conversationKey); activateConversationKey(conversationKey); capturedSession.discardPendingUpdates(); capturedSession.setMessages([]);
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

  return {
    archiveSession,
    removed: async (hostId: string, sessionPath: string | undefined, sessionId?: string) => {
      const pool = runtimePool();
      const matches = (session: SessionSummary) => (session.hostId ?? "local") === hostId && (session.id === sessionId || Boolean(sessionPath && session.path === sessionPath));
      const summaries = pool.liveSessionSummaries().filter(matches);
      let current = chatSession().state;
      let selected = activeHostId() === hostId && (current.sessionId === sessionId || Boolean(sessionPath && current.sessionFile === sessionPath));
      const id = sessionId ?? (selected ? current.sessionId : summaries[0]?.id);
      if (id && archivePending().has(`${hostId}:${id}`)) return true;
      const removalKey = `${hostId}:${id ?? sessionPath}`;
      if (removalPending.has(removalKey)) return false;
      removalPending.add(removalKey);
      try {
        const keys = new Set(summaries.map((session) => `${hostId}:${session.id}`));
        if (id) keys.add(`${hostId}:${id}`);
        const terminalIds = new Set([...keys].flatMap(conversationTerminalIds));
        const terminalTransport = transport();
        const closed = await Promise.allSettled([...terminalIds].map((terminalId) => terminalTransport.closeTerminal(terminalId)));
        const failed = closed.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          addNotice({ title: "Could not close archived conversation terminals", message: String(failed.reason) });
          return false;
        }
        for (const key of keys) removeConversationTerminals(key);
        current = chatSession().state;
        selected = activeHostId() === hostId && (current.sessionId === sessionId || Boolean(sessionPath && current.sessionFile === sessionPath));
        if (id) archivedSessionKeys.current.add(`${hostId}:${id}`);
        for (const session of summaries) {
          if (isSplitSession(session)) closeSplitPane();
          removeDraft(`${hostId}:${session.id}`);
        }
        if (selected) {
          const previous = transport();
          const key = `${hostId}:draft-${crypto.randomUUID()}`;
          const replacement = pool.create({ hostId });
          removeDraft(`${hostId}:${current.sessionId}`);
          chatSession().discardPendingUpdates();
          transportConversationKeys.current.set(replacement, key);
          batch(() => {
            setActiveCwd(undefined);
            updateConnected(false);
            activateConversationKey(key);
            activateTransport(replacement);
          });
          void pool.release(previous).catch((reason) => addNotice({ title: "Could not close archived conversation", message: String(reason) })).finally(() => transportConversationKeys.current.delete(previous));
        }
        for (const session of summaries) void pool.remove(session).catch((reason) => addNotice({ title: "Could not close archived conversation", message: String(reason) }));
        return true;
      } finally { removalPending.delete(removalKey); }
    },
    restored: (hostId: string, sessionId: string) => archivedSessionKeys.current.delete(`${hostId}:${sessionId}`),
    isPending: (session: SessionSummary) => archivePending().has(`${session.hostId ?? "local"}:${session.id}`),
    isArchived: (session: SessionSummary) => archivedSessionKeys.current.has(`${session.hostId ?? "local"}:${session.id}`),
  };
}
