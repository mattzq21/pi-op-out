import { required } from "./lib/required";
import { createMemo, onCleanup, type Accessor, type Setter } from "solid-js";
import { hasVisibleText } from "./lib/content";
import type { NativeTransport } from "./lib/nativeTransport";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import type { RefObject } from "./lib/solid";
import type { useChatSession } from "./lib/useChatSession";
import type { SessionSummary } from "./types";
import { flushAllPlugins } from "./plugins/lifecycle";

declare global {
  interface WindowEventMap {
    "piop-mobile-before-disconnect": CustomEvent<{ waitUntil: (task: Promise<void>) => void }>;
  }
}

export function createConversationViewKey<T>(transport: Accessor<T>, conversationKey: Accessor<string>, submission: Accessor<object | undefined> = () => undefined) {
  let previous: { owner: T; key: string; identity: object; submission?: object } | undefined;

  return createMemo(() => {
    const owner = transport();
    const key = conversationKey();
    const pending = submission();
    const canonicalizingDraft = previous?.key.includes(":draft-") && !key.includes(":draft-");
    const continuingSubmission = pending !== undefined && pending === previous?.submission;
    const reuse = continuingSubmission || previous?.owner === owner && (previous.key === key || canonicalizingDraft);
    const identity = reuse ? required(previous).identity : {};
    previous = { owner, key, identity, submission: pending };

    return identity;
  });
}

export function useWorkspaceDisconnect(hasDrafts: () => boolean, pool: () => SessionRuntimePool, draftTerminalIds: () => string[], owner: () => NativeTransport) {
  const beforeDisconnect = (event: WindowEventMap["piop-mobile-before-disconnect"]) => {
    if (hasDrafts() && !window.confirm("Disconnect? Draft messages, interrupted messages, attachments, and unsaved settings will be discarded.")) { event.preventDefault();

    return; }

    const close = async () => {
      await flushAllPlugins();
      await Promise.all(draftTerminalIds().map(id => owner().closeTerminal(id)));
      await pool().disconnectAll(true);
    };

    event.detail.waitUntil(close());
  };

  window.addEventListener("piop-mobile-before-disconnect", beforeDisconnect);
  onCleanup(() => {
    window.removeEventListener("piop-mobile-before-disconnect", beforeDisconnect);

    const runtimePool = pool();
    void Promise.allSettled(draftTerminalIds().map(id => owner().closeTerminal(id))).then(() => runtimePool.disconnectAll());
  });
}

type ActivationContext = {
  savedSessions: Accessor<SessionSummary[]>;
  transport: Accessor<NativeTransport>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  transportHasDraft: (owner: NativeTransport, key?: string) => boolean;
  conversationTerminalIds: (key: string) => string[];
  runtimePool: Accessor<SessionRuntimePool>;
  chatSession: Accessor<ReturnType<typeof useChatSession>>;
  composerDrafts: Accessor<Record<string, string>>;
  activeTransportRef: RefObject<NativeTransport>;
  setTransport: Setter<NativeTransport>;
  discardDraft: (owner: NativeTransport, key?: string) => void;
  forgetTerminals: (key: string) => void;
};

export function createTransportActivation(context: ActivationContext) {
  const { transport, transportConversationKeys, transportHasDraft, conversationTerminalIds, runtimePool, chatSession, composerDrafts, activeTransportRef, setTransport, discardDraft, forgetTerminals } = context;
  const savedConversation = () => context.savedSessions().some(session => !session.isDraft && session.messageCount > 0 && (session.hostId ?? "local") === transport().currentHostId() && session.path === transport().currentSessionPath());
  const emptyConversation = () => !savedConversation() && chatSession().state.messageCount === 0 && chatSession().messages.length === 0 && !chatSession().state.isStreaming && chatSession().state.pendingMessageCount === 0;

  const retainDraft = (previousTransport: NativeTransport, previousKey: string) => {
      const hostId = previousTransport.currentHostId(); const id = previousKey.slice(hostId.length + 1); const draft = composerDrafts()[previousKey] ?? ""; const cwd = previousTransport.currentCwd() ?? "";
      runtimePool().bind(hostId, id, previousTransport);
      runtimePool().setLiveSession(previousTransport, { id, hostId, isDraft: true, path: previousTransport.currentSessionPath() ?? "", cwd, project: cwd.split("/").filter(Boolean).at(-1) ?? "Workspace", name: hasVisibleText(draft) ? draft.slice(0, 60) : "Unsent draft", preview: draft, messageCount: 0, lastMessageAt: Date.now(), apiCost: 0 });
  };

  const discardTransport = (previousTransport: NativeTransport, previousKey: string | undefined) => {
      discardDraft(previousTransport, previousKey);
      let closingTerminals: Promise<PromiseSettledResult<void>[]> = Promise.resolve([]);

      if (previousKey) {
        const terminalIds = conversationTerminalIds(previousKey);

        closingTerminals = Promise.allSettled(terminalIds.map((id) => previousTransport.closeTerminal(id)));
      }

      const pool = runtimePool();
      const stopTracking = previousTransport.onDispose(() => transportConversationKeys.current.delete(previousTransport));
      void closingTerminals.then(async results => {
        const failed = results.find(result => result.status === "rejected");

        if (failed?.status === "rejected") throw failed.reason;
        if (previousKey) forgetTerminals(previousKey);
        await pool.release(previousTransport);
      }).catch(reason => { stopTracking(); pool.reportError(`Could not release conversation: ${(reason instanceof Error ? reason.message : String(reason))}`); });
  };

  const hasDraftWork = (owner: NativeTransport, key: string | undefined) => transportHasDraft(owner, key) || owner.hasTerminalActivity() || Boolean(key && conversationTerminalIds(key).some(id => !owner.isPreparedTerminal(id)));

  const inactiveCleanups = new Map<NativeTransport, () => void>();
  onCleanup(() => { for (const stop of inactiveCleanups.values()) stop(); inactiveCleanups.clear(); });

  const watchInactive = (owner: NativeTransport) => {
    inactiveCleanups.get(owner)?.();
    const state = chatSession().state;
    let streaming = state.isStreaming;
    let compacting = state.isCompacting;
    let paused = state.isPaused;
    let pausing = state.isPausing;
    let stopped = false;
    let scheduled = false;
    const check = () => {
      if (scheduled || stopped) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (stopped || streaming || compacting || paused || pausing) return;
        runtimePool().detachIdle(owner, () => !hasDraftWork(owner, transportConversationKeys.current.get(owner)));
      });
    };
    const unsubscribe = owner.subscribe(event => {
      if (event.type === "agent_start") { streaming = true; paused = false; }
      if (event.type === "runtime_presence") streaming = event.isStreaming === true;
      if (event.type === "agent_settled") streaming = false;
      if (event.type === "pause_state") { paused = event.isPaused === true; pausing = event.isPausing === true; }
      if (event.type === "compaction_start" || event.type === "auto_compaction_start") compacting = true;
      if (event.type === "compaction_end" || event.type === "auto_compaction_end") compacting = false;
      if (["agent_settled", "runtime_presence", "pause_state", "compaction_end", "auto_compaction_end", "queue_update", "settings_applied"].includes(event.type)) check();
    });
    let stopDisposal: (() => void) | undefined;
    const stop = () => { stopped = true; unsubscribe(); stopDisposal?.(); inactiveCleanups.delete(owner); };
    inactiveCleanups.set(owner, stop);
    stopDisposal = owner.onDispose(() => { stop(); transportConversationKeys.current.delete(owner); });
    check();
  };

  return (nextTransport: NativeTransport) => {
    inactiveCleanups.get(nextTransport)?.();
    const previousTransport = transport();
    const previousKey = transportConversationKeys.current.get(previousTransport);
    const hasUnsentWork = hasDraftWork(previousTransport, previousKey);

    const nextKey = transportConversationKeys.current.get(nextTransport);
    const nextIsDraft = Boolean(nextKey?.includes(":draft-"));
    const leavingEmpty = previousTransport !== nextTransport && emptyConversation();

    if (leavingEmpty && hasUnsentWork && previousKey && !nextIsDraft) retainDraft(previousTransport, previousKey);
    const state = chatSession().state;
    const settled = !state.isStreaming && !state.isCompacting && !state.isPausing && !state.isPaused && !runtimePool().isRunning(previousTransport) && !state.pendingMessageCount && !state.pendingMessages?.length;
    const discardPrevious = leavingEmpty && previousKey !== nextKey && !hasUnsentWork && settled;
    if (previousTransport !== nextTransport && !leavingEmpty) watchInactive(previousTransport);
    activeTransportRef.current = nextTransport; runtimePool().activate(nextTransport); setTransport(nextTransport);

    if (discardPrevious) discardTransport(previousTransport, previousKey);
  };
}
