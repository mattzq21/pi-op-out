import type { Accessor, Setter } from "solid-js";
import type { SessionTerminals } from "./appSupport";
import { hasVisibleText } from "./lib/content";
import type { NativeTransport } from "./lib/nativeTransport";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import type { RefObject } from "./lib/solid";
import type { useChatSession } from "./lib/useChatSession";
import type { ComposerUpload } from "./types";

type ActivationContext = {
  transport: Accessor<NativeTransport>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  transportHasDraft: (owner: NativeTransport, key?: string) => boolean;
  conversationTerminalIds: (key: string) => string[];
  runtimePool: Accessor<SessionRuntimePool>;
  chatSession: Accessor<ReturnType<typeof useChatSession>>;
  composerDrafts: Accessor<Record<string, string>>;
  activeTransportRef: RefObject<NativeTransport>;
  setTransport: Setter<NativeTransport>;
  setUploadsByTransport: Setter<Map<NativeTransport, ComposerUpload[]>>;
  setComposerDrafts: Setter<Record<string, string>>;
  setTerminalsBySession: Setter<Record<string, SessionTerminals>>;
};

export function createTransportActivation(context: ActivationContext) {
  const { transport, transportConversationKeys, transportHasDraft, conversationTerminalIds, runtimePool, chatSession, composerDrafts, activeTransportRef, setTransport, setUploadsByTransport, setComposerDrafts, setTerminalsBySession } = context;
  const emptyConversation = () => chatSession().state.messageCount === 0 && chatSession().messages.length === 0;
  const retainDraft = (previousTransport: NativeTransport, previousKey: string) => {
      const hostId = previousTransport.currentHostId(); const id = previousKey.slice(hostId.length + 1); const draft = composerDrafts()[previousKey] ?? ""; const cwd = previousTransport.currentCwd() ?? "";
      runtimePool().bind(hostId, id, previousTransport);
      runtimePool().setLiveSession(previousTransport, { id, hostId, isDraft: true, path: previousTransport.currentSessionPath() ?? "", cwd, project: cwd.split("/").filter(Boolean).at(-1) ?? "Workspace", name: hasVisibleText(draft) ? draft.slice(0, 60) : "Unsent draft", preview: draft, messageCount: 0, lastMessageAt: Date.now(), apiCost: 0 });
  };
  const discardTransport = (previousTransport: NativeTransport, previousKey: string | undefined) => {
      setUploadsByTransport((current) => { const next = new Map(current); next.delete(previousTransport); return next; });
      if (previousKey) {
        setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
        const terminalIds = conversationTerminalIds(previousKey);
        if (terminalIds.length) void Promise.allSettled(terminalIds.map((id) => previousTransport.closeTerminal(id)));
        setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
      }
      void runtimePool().release(previousTransport).finally(() => transportConversationKeys.current.delete(previousTransport));
  };
  const shouldDiscard = (previous: NativeTransport, next: NativeTransport, hasUnsentWork: boolean) => previous !== next && !runtimePool().isRetained(previous) && !chatSession().state.isStreaming && emptyConversation() && !hasUnsentWork;
  return (nextTransport: NativeTransport) => {
    const previousTransport = transport();
    const previousKey = transportConversationKeys.current.get(previousTransport);
    const hasUnsentWork = transportHasDraft(previousTransport, previousKey) || previousTransport.hasTerminalActivity() || Boolean(previousKey && conversationTerminalIds(previousKey).length);
    if (previousTransport !== nextTransport && previousKey && hasUnsentWork && !runtimePool().isRetained(previousTransport) && emptyConversation()) retainDraft(previousTransport, previousKey);
    const discardPrevious = shouldDiscard(previousTransport, nextTransport, hasUnsentWork);
    activeTransportRef.current = nextTransport; runtimePool().activate(nextTransport); setTransport(nextTransport);
    if (discardPrevious) discardTransport(previousTransport, previousKey);
  };
}
