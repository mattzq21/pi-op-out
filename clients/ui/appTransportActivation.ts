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
      }).catch(reason => { stopTracking(); pool.reportError(`Could not release conversation: ${String(reason)}`); });
  };

  const hasDraftWork = (owner: NativeTransport, key: string | undefined) => transportHasDraft(owner, key) || owner.hasTerminalActivity() || Boolean(key && conversationTerminalIds(key).some(id => !owner.isPreparedTerminal(id)));

  return (nextTransport: NativeTransport) => {
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
    const detachPrevious = previousTransport !== nextTransport && !leavingEmpty && settled && !hasUnsentWork;
    activeTransportRef.current = nextTransport; runtimePool().activate(nextTransport); setTransport(nextTransport);

    if (discardPrevious) discardTransport(previousTransport, previousKey);
    else if (detachPrevious) runtimePool().detachIdle(previousTransport, () => !hasDraftWork(previousTransport, previousKey));
  };
}
