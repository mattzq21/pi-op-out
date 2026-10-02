import { z } from "zod";
import { sessionSnapshotSchema, modelSchema, slashCommandSchema, agentStateSchema } from "./responseSchemas";
import { ConversationChangedError } from "./conversationChanged";
import { type Accessor, createComputed, createMemo, onCleanup, untrack } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import type { AgentState, ChatMessage, Model, RpcEvent, SlashCommand } from "../types";
import { chatSessionEventSchema, pendingMessagesSchema, type ChatSessionEvent } from "./chatSessionEventSchema";
import { promptContextSchema, wireMessageSchema, type WireMessage } from "./messageSchemas";
import { contextUsageAfterCompaction } from "./contextUsage";
import { appendFileChanges, applyAssistantMessageEvent, branchMessages, checkpointLatestUser, isResumeMessage, normalizeMessage, resumeMarker, type PiEntry } from "./messages";
import type { NativeTransport } from "./nativeTransport";
import { useSessionMemory } from "./sessionMemory";

interface SessionSnapshot { revision: string; state: AgentState; history: { entries: PiEntry[]; leafId: string | null; omittedEntries?: number }; sequence: number; epoch: string; liveTools: RpcEvent[]; queue: RpcEvent; }

type MessageUpdate = (messages: ChatMessage[], positions: (id: string | undefined) => number[]) => boolean;

const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };

function messagePositions(messages: ChatMessage[]) {
  let indexed: Map<string | undefined, { through: number; positions: number[] }> | undefined;

  return (id: string | undefined) => {
    indexed ??= new Map();
    const entry = indexed.get(id) ?? { through: 0, positions: [] };

    for (; entry.through < messages.length; entry.through++) {
      if (messages[entry.through].id === id) entry.positions.push(entry.through);
    }

    indexed.set(id, entry);

    return entry.positions;
  };
}

export function useChatSession(transport: Accessor<Pick<NativeTransport, "command" | "subscribe"> & Partial<Pick<NativeTransport, "ownsConversation" | "promptControls">>>, initialState: Accessor<AgentState> = () => emptyState, options: { poll?: boolean } = {}) {
  const runtime = createMemo(() => {
    const current = transport();

    return untrack(() => createChatSession(() => current, initialState, options));
  });

  return {
    get state() { return runtime().state; }, get setState() { return runtime().setState; },
    get messages() { return runtime().messages; }, get setMessages() { return runtime().setMessages; },
    get models() { return runtime().models; }, get commands() { return runtime().commands; },
    get thinkingLevels() { return runtime().thinkingLevels; }, get refresh() { return runtime().refresh; },
    get handleEvent() { return runtime().handleEvent; }, get discardPendingUpdates() { return runtime().discardPendingUpdates; },
  };
}

function createChatSession(transport: Accessor<Pick<NativeTransport, "command" | "subscribe"> & Partial<Pick<NativeTransport, "ownsConversation" | "promptControls">>>, initialState: Accessor<AgentState>, options: { poll?: boolean }) {
  const session = useSessionMemory(() => (transport()), () => (initialState()));
  const owner = createRef<ReturnType<typeof transport> | undefined>(transport());
  const loading = new AbortController();
  onCleanup(() => { owner.current = undefined; loading.abort(); });

  const load = <S extends z.ZodType>(command: Parameters<ReturnType<typeof transport>["command"]>[0], schema: S): Promise<z.output<S>> => {
    if (loading.signal.aborted) return Promise.reject(new ConversationChangedError());

    return new Promise<z.output<S>>((resolve, reject) => {
      const cancel = () => reject(new ConversationChangedError());
      loading.signal.addEventListener("abort", cancel, { once: true });
      transport().command(command, schema).then(resolve, reject).finally(() => loading.signal.removeEventListener("abort", cancel));
    });
  };

  const capabilityRequest = createRef(0);
  const refreshOperation = createRef<{ transport: ReturnType<typeof transport>; promise: Promise<AgentState>; buffer: RpcEvent[] } | undefined>(undefined);
  const bufferedEvents = createRef<RpcEvent[] | undefined>(undefined);
  const eventHandler = createRef<(event: RpcEvent) => void>(() => undefined);
  const resumeMarkers = createRef(new Set<string>());
  const liveRevision = createRef(0); const activeAssistantId = createRef<string | undefined>(undefined); const activeMessageIds = createRef(new Map<string, string>()); const liveMessageSequence = createRef(0); const pendingUpdates = createRef<MessageUpdate[]>([]); const frame = createRef<number | undefined>(undefined);
  const pendingRevision = createRef<{ base: string | undefined; next: string } | undefined>(undefined);
  const nextLiveMessageId = (role: string) => `live-${role.slice(0, 32)}-${Date.now()}-${++liveMessageSequence.current}`;

  const trackLiveId = (roleKey: string, liveId: string) => {
    if (activeMessageIds.current.size >= 32 && !activeMessageIds.current.has(roleKey)) {
      const oldest = activeMessageIds.current.keys().next();

      if (!oldest.done) activeMessageIds.current.delete(oldest.value);
    }

    activeMessageIds.current.set(roleKey, liveId);
  };

  const flush = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    const updates = pendingUpdates.current.splice(0);
    const revision = pendingRevision.current;
    pendingRevision.current = undefined;

    if (updates.length) session.setMessages((current) => {
      const next = [...current];
      const positions = messagePositions(next);
      let changed = false;

      for (const update of updates) changed = update(next, positions) || changed;

      return changed ? next : current;
    });

    if (revision && session.memory.revision === revision.base) session.memory.markRevision(revision.next);
  };

  const queue = (update: MessageUpdate) => { pendingUpdates.current.push(update);

  if (frame.current === undefined) frame.current = requestAnimationFrame(flush); };

  const discardPendingUpdates = () => { if (pendingRevision.current) flush();

  if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; pendingUpdates.current.length = 0; pendingRevision.current = undefined; };

  const flushBeforeEvent = (event: RpcEvent) => {
    if (!pendingRevision.current) return;

    if (event.previousRevision !== pendingRevision.current.next || !["message_update", "tool_execution_update"].includes(event.type)) flush();
  };

  const advanceRevision = (event: ChatSessionEvent) => {
    if (event.revision === undefined || (pendingRevision.current?.next ?? session.memory.revision) !== event.previousRevision) return;

    if (["entry_appended", "message_end", "agent_settled", "session_info_changed", "session_switched", "settings_applied", "disconnected", "model_select"].includes(event.type)) return;

    if (pendingUpdates.current.length) {
      pendingRevision.current = { base: pendingRevision.current ? pendingRevision.current.base : session.memory.revision, next: event.revision };
    } else session.memory.markRevision(event.revision);
  };

  createDependencyEffect(() => discardPendingUpdates, () => [discardPendingUpdates]);
  createDependencyEffect(() => { liveRevision.current += 1; activeAssistantId.current = undefined; activeMessageIds.current.clear(); resumeMarkers.current.clear(); bufferedEvents.current = undefined; discardPendingUpdates(); }, () => [discardPendingUpdates, transport()]);

  const refresh = (): Promise<AgentState> => {
    if (owner.current !== transport()) return Promise.reject(new ConversationChangedError());
    flush();

    if (refreshOperation.current?.transport === transport()) return refreshOperation.current.promise;
    const buffer: RpcEvent[] = []; bufferedEvents.current = buffer;

    const restoreHistory = (snapshot: SessionSnapshot) => {
      for (const entry of snapshot.history.entries) { const marker = resumeMarker(entry);

      if (marker) resumeMarkers.current.add(marker); }

      const previous = new Map(session.memory.getSnapshot().messages.filter((message) => message.toolPayloadLoaded && message.toolStatus !== "running").map((message) => [message.deferredToolPayload, message]));

      const nextMessages = branchMessages(snapshot.history.entries, snapshot.history.leafId).map((message) => {
        const cached = previous.get(message.deferredToolPayload);

        return cached ? { ...message, content: cached.content, details: cached.details, toolInput: cached.toolInput, toolPayloadLoaded: true, loadToolPayload: cached.loadToolPayload } : message;
      });

      if (snapshot.history.omittedEntries) nextMessages.unshift({ id: "client-memory-limit", role: "system", content: "Older history was omitted to fit this client's memory limit. The full conversation remains on the host." });
      activeAssistantId.current = [...nextMessages].reverse().find((message) => message.role === "assistant" && message.streaming)?.id;
      activeMessageIds.current.clear();

      for (const message of nextMessages.filter((message) => message.streaming)) trackLiveId(message.role, message.id);
      session.setMessages(nextMessages);
    };

    const restoreCapabilities = (modelResult?: { models: Model[] }, thinkingResult?: { levels: string[] }, commandResult?: { commands: SlashCommand[] }) => {
      if (modelResult) session.setModels(modelResult.models);

      if (thinkingResult) session.setThinkingLevels(thinkingResult.levels);

      if (commandResult) {
        const visible = commandResult.commands.filter((command) => command.sourceInfo?.source !== "inline" && !command.name.startsWith("pi-orchestration-") && !["pi-desktop-control", "pi-desktop-fast-status", "pi-desktop-fork-and-forget", "pi-desktop-fork-after", "pi-desktop-branch-checkpoint", "mcp", "mcp-status", "piop-runtime-settings"].includes(command.name));
        session.setCommands(visible.some((command) => command.name === "compact") ? visible : [{ name: "compact", description: "Compact conversation context", source: "builtin" }, ...visible]);
      }
    };

    const replaySnapshotEvents = (snapshot: SessionSnapshot) => {
      for (const event of snapshot.liveTools) { eventHandler.current(event);

      if (event.partialResult) eventHandler.current({ ...event, sequence: snapshot.sequence, type: "tool_execution_update" }); }

      for (const raw of buffer) {
        const event = chatSessionEventSchema.parse(raw);

        if (event.sequence === undefined || (event.epoch === snapshot.epoch && event.sequence > snapshot.sequence)) eventHandler.current(event);
      }
    };

    const finishRefresh = () => {
      if (bufferedEvents.current === buffer) { bufferedEvents.current = undefined;

      if (owner.current === transport()) for (const event of buffer) eventHandler.current(event); }

      if (refreshOperation.current?.buffer === buffer) refreshOperation.current = undefined;
    };

    const promise = (async () => { const capturedTransport = transport();

      try {
        const { revision } = await load({ type: "get_session_revision" }, z.object({ revision: z.string() }));

        if (owner.current !== capturedTransport) throw new ConversationChangedError();

        if (session.memory.revision === revision) {
          for (const message of session.memory.getSnapshot().messages.filter((message) => message.streaming)) trackLiveId(message.role, message.id);
          activeAssistantId.current = [...session.memory.getSnapshot().messages].reverse().find((message) => message.role === "assistant" && message.streaming)?.id;

          return session.memory.getSnapshot().state;
        }

        const request = ++capabilityRequest.current;
        const snapshotRequest = load({ type: "get_snapshot" }, sessionSnapshotSchema);

        const capabilities = () => Promise.all([
          load({ type: "get_available_models" }, z.object({ models: z.array(modelSchema) })).catch(() => undefined),
          load({ type: "get_available_thinking_levels" }, z.object({ levels: z.array(z.string()) })).catch(() => undefined),
          load({ type: "get_commands" }, z.object({ commands: z.array(slashCommandSchema) })).catch(() => undefined),
          load({ type: "get_session_stats" }, z.object({ contextUsage: agentStateSchema.shape["contextUsage"].optional() })).catch(() => undefined),
        ]);

        const snapshot = await snapshotRequest;

        if (owner.current !== capturedTransport || bufferedEvents.current !== buffer) throw new ConversationChangedError();

        if (buffer.some((event) => (event.type === "session_switched" && event.epoch !== snapshot.epoch) || (event.type === "session_info_changed" && Number(event.sequence) > snapshot.sequence))) {
          refreshOperation.current = undefined; bufferedEvents.current = undefined;

          return refresh();
        }

        discardPendingUpdates();
        session.memory.batch(() => {
          restoreHistory(snapshot);
          session.setState(current => ({ ...snapshot.state,
            contextUsage: snapshot.state.contextUsage ?? (current.sessionId === snapshot.state.sessionId ? current.contextUsage : undefined),
            pendingMessages: pendingMessagesSchema.parse(snapshot.queue.pendingMessages) }));
          capturedTransport.promptControls?.acknowledge(snapshot.state);
        });
        session.memory.markRevision(snapshot.revision);
        bufferedEvents.current = undefined;
        replaySnapshotEvents(snapshot);
        void capabilities().then(([modelResult, thinkingResult, commandResult, statsResult]) => {
          if (owner.current !== capturedTransport || capabilityRequest.current !== request || !session.memory.revision) return;
          session.memory.batch(() => {
            restoreCapabilities(modelResult, thinkingResult, commandResult);

            if (statsResult?.contextUsage) session.setState((current) => ({ ...current, contextUsage: statsResult.contextUsage }));
          });
        }).catch(() => undefined);

        return snapshot.state;
      } finally {
        finishRefresh();
      }
    })();

    refreshOperation.current = { transport: transport(), promise, buffer };

    return promise;
  };

  createDependencyEffect(() => { const capturedTransport = transport();

    if (options.poll === false) return;
    let stopped = false;
    let viewing = capturedTransport.ownsConversation?.() === false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try { await refresh(); } catch { }

      if (!stopped && viewing) timer = setTimeout(() => void poll(), 2000);
    };

    const unsubscribe = capturedTransport.subscribe((event) => {
      if (event.type === "ownership_lost" && !viewing) { viewing = true; void poll(); }

      if (event.type === "ownership_acquired" || event.type === "disconnected") { viewing = false; clearTimeout(timer); }
    });

    if (viewing) void poll();

    return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
  }, () => [refresh, transport()]);

  const handleEvent = (raw: RpcEvent) => {
    if (owner.current !== transport()) return;
    const event = chatSessionEventSchema.parse(raw);

    if (bufferedEvents.current) { bufferedEvents.current.push(event);

    return; }

    flushBeforeEvent(event);

    if (["agent_start", "agent_end", "agent_settled", "pause_state", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) liveRevision.current += 1;

    const handleRuntimePresence = () => {
      session.setState((current) => ({ ...current, viewers: Number(event.viewers), isStreaming: event.isStreaming === true }));
    };

    const handleExtensionUiRequest = () => {
      if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-desktop-prompt-context" && event.statusText?.startsWith("json:")) {
        try {
          const context = promptContextSchema.parse(JSON.parse(event.statusText.slice(5)));

          if (context.userTimestamp !== undefined) {
            liveRevision.current += 1;
            session.setMessages((current) => current.map((message) => message.role === "user" && message.timestamp === context.userTimestamp && (!message.promptContext || (message.promptContext.inputTokens === undefined && context.inputTokens !== undefined)) ? { ...message, promptContext: context } : message));
          }
        } catch { }
      }
    };

    const handleEntryAppended = () => {
      if (event.type === "entry_appended" && event.entry) { const entry = event.entry; const marker = resumeMarker(entry);

      if (marker) { resumeMarkers.current.add(marker); session.setMessages(checkpointLatestUser); }

      if (entry.customType === "piop-file-changes") { liveRevision.current += 1; session.setMessages((current) => appendFileChanges(current, entry)); } }
    };

    const handleAgentStart = () => {
      session.setState((current) => ({ ...current, isStreaming: true, isPaused: false }));
    };

    const handlePauseState = () => {
      session.setState((current) => {
        const next = { ...current, isPaused: event.isPaused === true, isPausing: event.isPausing === true };

        if (next.isPaused && !next.isPausing) {
          next.isStreaming = false;
          next.activity = undefined;
        }

        return next;
      });

      if (event.type === "pause_state" && event.isPaused === true && event.isPausing !== true) { flush(); session.setMessages(checkpointLatestUser); }
    };

    const handleAgentSettled = () => {
      session.setState((current) => ({ ...current, isStreaming: false, activity: undefined }));
      const revision = liveRevision.current;
      void load({ type: "get_session_stats" }, z.object({ contextUsage: agentStateSchema.shape["contextUsage"].optional() })).then((stats) => {
        if (owner.current === transport() && revision === liveRevision.current && stats.contextUsage) session.setState((current) => ({ ...current, contextUsage: stats.contextUsage }));
      }).catch(() => undefined);
    };

    const handleDisconnected = () => {
      session.setState((current) => ({ ...current, isStreaming: false, isCompacting: false, isPausing: false, activity: undefined }));
    };

    const messageLiveId = (rawMessage: WireMessage, roleKey: string) => {
      const toolCallId = rawMessage.toolCallId;

      return rawMessage.role === "toolResult" && toolCallId !== undefined ? toolCallId : event.type === "message_start" ? nextLiveMessageId(roleKey) : activeMessageIds.current.get(roleKey) ?? nextLiveMessageId(roleKey);
    };

    const updateAssistant = (message: ChatMessage) => {
      if (message.role === "assistant" && event.type === "message_start") { message = { ...message, streaming: true }; activeAssistantId.current = message.id; }

      if (message.role === "assistant" && event.type === "message_end") { message = { ...message, id: activeAssistantId.current || message.id, completedAt: Date.now(), streaming: false }; activeAssistantId.current = undefined; }

      return message;
    };

    const handleMessageStart = () => {
      if (event.type === "message_end") flush();
      const rawMessage = event.message ?? wireMessageSchema.parse({}); const roleKey = rawMessage.role ?? "message";

      if (isResumeMessage(rawMessage, resumeMarkers.current)) return;

      if (rawMessage.role === "custom" && rawMessage.display === false) return;
      const liveId = messageLiveId(rawMessage, roleKey);

      if (event.type === "message_start") trackLiveId(roleKey, liveId); else activeMessageIds.current.delete(roleKey);
      let message = normalizeMessage(rawMessage, undefined, undefined, liveId);

      if (message.customType === "pi-desktop-btw") return;
      message = updateAssistant(message);
      session.setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? { ...message, toolInput: message.toolInput ?? item.toolInput, details: message.details ?? item.details, fileChanges: item.fileChanges, promptContext: item.promptContext } : item) : [...current, message]);
    };

    const handleMessageUpdate = () => {
      const assistantEvent = event.assistantMessageEvent;

      if (assistantEvent) queue((current) => { let index = -1;

      for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) { const message = current[candidate];

      if (message.role === "assistant" && (message.id === activeAssistantId.current || message.streaming)) { index = candidate; break; } }

      if (index < 0) return false; current[index] = applyAssistantMessageEvent(current[index], assistantEvent);

      return true; });
      else if (event.message) { const rawMessage = event.message; const roleKey = rawMessage.role ?? "message"; let liveId = activeMessageIds.current.get(roleKey);

      if (!liveId) { liveId = nextLiveMessageId(roleKey); trackLiveId(roleKey, liveId); }

      const message = { ...normalizeMessage(rawMessage, undefined, undefined, liveId), streaming: true }; queue((current, positions) => { const matches = positions(message.id);

      for (const index of matches) current[index] = message;

      if (!matches.length) current.push(message);

      return true; }); }
    };

    const handleToolExecutionStart = () => {
      if (event.parentToolCallId) return;
      const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: String(event.toolName), toolStatus: "running", content: "", timestamp: Date.now() };
      session.setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
    };

    const handleToolExecutionUpdate = () => {
      if (event.parentToolCallId) return;
      queue((current, positions) => {
        const matches = positions(event.toolCallId);

        for (const index of matches) {
          const item = current[index];
          current[index] = { ...item, toolPayloadVersion: Number(event.sequence), toolStatus: "running" };
        }

        return matches.length > 0;
      });
    };

    const handleToolExecutionEnd = () => {
      if (event.parentToolCallId) return;
      flush();
      session.setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, toolPayloadVersion: Number(event.sequence), toolStatus: event.isError ? "error" : "done" } : item));
    };

    const handleQueueUpdate = () => {
      session.setState((current) => ({ ...current, pendingMessages: event.pendingMessages, pendingMessageCount: (event.steering?.length ?? 0) + (event.followUp?.length ?? 0) }));
    };

    const handleCompactionStart = () => {
      session.setState((current) => ({ ...current, isCompacting: true, activity: "Compacting context…" }));
      session.setMessages(current => [...current.filter(message => message.id !== "live-compaction"), { id: "live-compaction", role: "system", customType: "compaction", content: "Compacting context…", timestamp: Date.now() }]);
    };

    const handleCompactionEnd = () => {
      session.setState((current) => ({ ...current, isCompacting: false, activity: undefined, contextUsage: contextUsageAfterCompaction(current.contextUsage, event) }));
      session.setMessages(current => current.map(message => message.id === "live-compaction" ? { ...message, content: event.aborted ? "Compaction cancelled" : event.errorMessage ? `Compaction failed: ${String(event.errorMessage)}` : "Context compacted" } : message));

      if (!event.aborted && !event.errorMessage) void refresh().catch(() => undefined);
    };

    const handleAutoRetryStart = () => {
      session.setState((current) => ({ ...current, activity: `Retrying · attempt ${event.attempt}` }));
    };

    const handleThinkingLevelChanged = () => {
      const level = event.level;

      if (event.type === "thinking_level_changed" && level !== undefined) session.setState((current) => ({ ...current, thinkingLevel: level }));
    };

    const handlers = new Map(Object.entries({
      "runtime_presence": handleRuntimePresence,
      "extension_ui_request": handleExtensionUiRequest,
      "entry_appended": handleEntryAppended,
      "agent_start": handleAgentStart,
      "pause_state": handlePauseState,
      "agent_settled": handleAgentSettled,
      "disconnected": handleDisconnected,
      "message_start": handleMessageStart,
      "message_end": handleMessageStart,
      "message_update": handleMessageUpdate,
      "tool_execution_start": handleToolExecutionStart,
      "tool_execution_update": handleToolExecutionUpdate,
      "tool_execution_end": handleToolExecutionEnd,
      "queue_update": handleQueueUpdate,
      "compaction_start": handleCompactionStart,
      "auto_compaction_start": handleCompactionStart,
      "compaction_end": handleCompactionEnd,
      "auto_compaction_end": handleCompactionEnd,
      "auto_retry_start": handleAutoRetryStart,
      "thinking_level_changed": handleThinkingLevelChanged
    }));

    handlers.get(event.type)?.();
    advanceRevision(event);
  };

  createComputed(() => { eventHandler.current = handleEvent; });

  return { get state() { return session.state; }, get setState() { return session.setState; }, get messages() { return session.messages; }, get setMessages() { return session.setMessages; }, get models() { return session.models; }, get commands() { return session.commands; }, get thinkingLevels() { return session.thinkingLevels; }, get refresh() { return refresh; }, get handleEvent() { return handleEvent; }, get discardPendingUpdates() { return discardPendingUpdates; } };
}
