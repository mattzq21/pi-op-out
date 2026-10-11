import { registerModelSession, reportModels } from "./modelReports";
import { z } from "zod";
import { sessionSnapshotSchema, modelSchema, slashCommandSchema, agentStateSchema } from "./responseSchemas";
import { ConversationChangedError } from "./conversationChanged";
import { type Accessor, createComputed, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { createDependencyEffect, createRef } from "./solid";

import type { AgentState, ChatMessage, RpcEvent } from "../types";
import { DEFINED_AGENTS_STATUS_KEY } from "./agentProtocol";
import { chatSessionEventSchema, pendingMessagesSchema, type ChatSessionEvent } from "./chatSessionEventSchema";
import { promptContextSchema, wireMessageSchema, type WireMessage } from "./messageSchemas";
import { contextUsageAfterCompaction } from "./contextUsage";
import { appendQueuedProjectContext, applyAssistantMessageEvent, branchMessages, checkpointLatestUser, isContextInjection, isResumeMessage, normalizeMessage, resumeMarker, type PiEntry } from "./messages";
import type { NativeTransport } from "./nativeTransport";
import { useSessionMemory } from "./sessionMemory";
import { matchesSubmittedMessage, reconcileMessages, sameUserContent, upsertLiveMessage } from "./reconcileMessages";

interface SessionSnapshot { revision: string; state: AgentState; history: { entries: PiEntry[]; leafId: string | null; omittedEntries?: number; incomplete?: boolean; damagedLines?: number[] }; sequence: number; epoch: string; liveTools: RpcEvent[]; queue: RpcEvent; }

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

export function useChatSession(transport: Accessor<Pick<NativeTransport, "command" | "subscribe"> & Partial<Pick<NativeTransport, "ownsConversation" | "promptControls" | "currentHostId">>>, initialState: Accessor<AgentState> = () => emptyState, options: { poll?: boolean } = {}) {
  const runtime = createMemo(() => {
    const current = transport();

    return untrack(() => createChatSession(() => current, initialState, options));
  });

  return {
    get state() { return runtime().state; }, get setState() { return runtime().setState; },
    get messages() { return runtime().messages; }, get setMessages() { return runtime().setMessages; },
    get models() { return runtime().models; }, get commands() { return runtime().commands; },
    get thinkingLevels() { return runtime().thinkingLevels; }, get refresh() { return runtime().refresh; },
    get capabilityErrors() { return runtime().capabilityErrors; }, get capabilitiesLoading() { return runtime().capabilitiesLoading; }, get retryCapabilities() { return runtime().retryCapabilities; },
    get handleEvent() { return runtime().handleEvent; }, get discardPendingUpdates() { return runtime().discardPendingUpdates; },
  };
}

function createChatSession(transport: Accessor<Pick<NativeTransport, "command" | "subscribe"> & Partial<Pick<NativeTransport, "ownsConversation" | "promptControls" | "currentHostId">>>, initialState: Accessor<AgentState>, options: { poll?: boolean }) {
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
  const capabilityKey = createRef<string | undefined>(undefined);
  const [capabilityErrors, setCapabilityErrors] = createSignal<string[]>([]);
  const [capabilitiesLoading, setCapabilitiesLoading] = createSignal(false);
  const sessionEpoch = createRef("");
  const statsOperation = createRef<{ sessionId: string; revision: number; promise: Promise<void> } | undefined>(undefined);
  const refreshOperation = createRef<{ transport: ReturnType<typeof transport>; promise: Promise<AgentState>; buffer: RpcEvent[] } | undefined>(undefined);
  const bufferedEvents = createRef<RpcEvent[] | undefined>(undefined);
  const eventHandler = createRef<(event: RpcEvent) => void>(() => undefined);
  const resumeMarkers = createRef(new Set<string>());
  const liveRevision = createRef(0); const activeAssistantId = createRef<string | undefined>(undefined); const activeMessageIds = createRef(new Map<string, string>()); const liveMessageSequence = createRef(0); const pendingUpdates = createRef<MessageUpdate[]>([]); const frame = createRef<number | undefined>(undefined);
  const pendingRevision = createRef<{ base: string | undefined; next: string } | undefined>(undefined);

  const refreshStats = () => {
    const sessionId = session.state.sessionId;
    const revision = liveRevision.current;

    if (statsOperation.current?.sessionId === sessionId && statsOperation.current.revision === revision) return statsOperation.current.promise;

    const promise = load({ type: "get_session_stats" }, z.object({ contextUsage: agentStateSchema.shape["contextUsage"].optional() })).then(stats => {
      if (owner.current === transport() && session.state.sessionId === sessionId && liveRevision.current === revision && stats.contextUsage) session.setState(current => ({ ...current, contextUsage: stats.contextUsage }));
    }).catch(() => undefined).finally(() => {
      if (statsOperation.current?.promise === promise) statsOperation.current = undefined;
    });

    statsOperation.current = { sessionId, revision, promise };

    return promise;
  };

  const refreshCapabilities = () => {
    const key = `${sessionEpoch.current}:${session.state.sessionId}`;

    if (capabilityKey.current === key) return;
    capabilityKey.current = key;
    const request = ++capabilityRequest.current;
    setCapabilityErrors([]);
    setCapabilitiesLoading(true);
    const failed = (list: string) => (reason: unknown) => {
      if (owner.current !== transport() || capabilityRequest.current !== request || reason instanceof ConversationChangedError) return;
      setCapabilityErrors(current => [...current, `Could not load ${list}: ${reason instanceof Error ? reason.message : String(reason)}`]);
    };
    void Promise.all([
      load({ type: "get_available_models" }, z.object({ models: z.array(modelSchema) })).catch(failed("models")),
      load({ type: "get_available_thinking_levels" }, z.object({ levels: z.array(z.string()) })).catch(failed("thinking levels")),
      load({ type: "get_commands" }, z.object({ commands: z.array(slashCommandSchema) })).catch(failed("commands")),
    ]).then(([modelResult, thinkingResult, commandResult]) => {
      if (owner.current !== transport() || capabilityRequest.current !== request) return;
      session.memory.batch(() => {
        if (modelResult) { session.setModels(modelResult.models); void reportModels(transport().currentHostId?.() ?? "local", modelResult.models).catch(reason => console.error("Could not record available models", reason)); }

        if (thinkingResult) session.setThinkingLevels(thinkingResult.levels);

        if (commandResult) {
          const visible = commandResult.commands.filter(command => command.sourceInfo?.source !== "inline");

          session.setCommands(visible.some(command => command.name === "compact") ? visible : [{ name: "compact", description: "Compact conversation context", source: "builtin" }, ...visible]);
        }
      });

      if (!modelResult || !thinkingResult || !commandResult) capabilityKey.current = undefined;
    }).catch(reason => {
      if (capabilityRequest.current === request) capabilityKey.current = undefined;
      failed("chat choices")(reason);
    }).finally(() => {
      if (owner.current === transport() && capabilityRequest.current === request) setCapabilitiesLoading(false);
    });
  };

  onCleanup(registerModelSession(() => transport().currentHostId?.() ?? "local", async () => {
    capabilityKey.current = undefined;
    const request = ++capabilityRequest.current;
    setCapabilitiesLoading(true);
    const result = await load({ type: "get_available_models" }, z.object({ models: z.array(modelSchema) })).catch(reason => {
      if (owner.current === transport() && request === capabilityRequest.current && !(reason instanceof ConversationChangedError)) setCapabilityErrors(current => [...current.filter(message => !message.startsWith("Could not load models:")), `Could not load models: ${reason instanceof Error ? reason.message : String(reason)}`]);
      throw reason;
    }).finally(() => {
      if (owner.current === transport() && request === capabilityRequest.current) setCapabilitiesLoading(false);
    });

    if (owner.current !== transport() || request !== capabilityRequest.current) return;
    setCapabilityErrors(current => current.filter(message => !message.startsWith("Could not load models:")));
    session.setModels(result.models);
    await reportModels(transport().currentHostId?.() ?? "local", result.models);
  }));

  const invalidatesCapabilities = (event: ChatSessionEvent) => ["settings_applied", "model_select", "session_switched", "disconnected", "connection_restored"].includes(event.type) || (event.type === "extension_ui_request" && event.statusKey === DEFINED_AGENTS_STATUS_KEY);

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

      const cachedSession = session.memory.getSnapshot();
      const cachedMessages = !cachedSession.state.sessionId || cachedSession.state.sessionId === snapshot.state.sessionId ? cachedSession.messages : [];
      const previous = new Map(cachedMessages.filter((message) => message.toolPayloadLoaded && message.toolStatus !== "running").map((message) => [message.deferredToolPayload, message]));

      const nextMessages = branchMessages(snapshot.history.entries, snapshot.history.leafId).map((message) => {
        const cached = previous.get(message.deferredToolPayload);

        return cached && cached.loadedToolPayloadVersion === message.toolPayloadVersion ? { ...message, content: cached.content, details: cached.details, toolInput: cached.toolInput, nestedCalls: cached.nestedCalls, toolPayloadLoaded: true, loadedToolPayloadVersion: cached.loadedToolPayloadVersion, loadToolPayload: cached.loadToolPayload } : message;
      });

      if (snapshot.history.omittedEntries) nextMessages.unshift({ id: "client-memory-limit", role: "system", content: "Older history was omitted to fit this client's memory limit. The full conversation remains on the host." });
      if (snapshot.history.incomplete) nextMessages.push({ id: `client-transcript-damage:${snapshot.state.sessionId}`, role: "system", content: `Chat history is incomplete. Damaged record lines: ${snapshot.history.damagedLines?.join(", ") ?? "unknown"}. Some messages may be missing.` });
      activeAssistantId.current = [...nextMessages].reverse().find((message) => message.role === "assistant" && message.streaming)?.id;
      activeMessageIds.current.clear();

      for (const message of nextMessages.filter((message) => message.streaming)) trackLiveId(message.role, message.id);
      session.setMessages(reconcileMessages(cachedMessages, nextMessages));
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

          refreshCapabilities();

          return session.memory.getSnapshot().state;
        }

        const snapshotRequest = load({ type: "get_snapshot" }, sessionSnapshotSchema);

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
        sessionEpoch.current = snapshot.epoch;
        bufferedEvents.current = undefined;
        replaySnapshotEvents(snapshot);
        refreshCapabilities();

        if (!session.state.contextUsage) void refreshStats();

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

    if (raw.type === "extension_ui_request" && raw.method !== "setStatus") return;
    const event = chatSessionEventSchema.parse(raw);

    if (invalidatesCapabilities(event)) {
      capabilityKey.current = undefined;
      capabilityRequest.current += 1;
    }

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

      if (entry.customType === "piop-queued-project-context") { liveRevision.current += 1; session.setMessages((current) => appendQueuedProjectContext(current, entry)); }

    }
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
      void refreshStats();
    };

    const handleDisconnected = () => {
      session.setState((current) => ({ ...current, isStreaming: false, isCompacting: false, isPausing: false, activity: undefined }));
    };

    const messageLiveId = (rawMessage: WireMessage, roleKey: string, normalized: ChatMessage) => {
      const submitted = session.messages.find(message => matchesSubmittedMessage(message, normalized));

      if (submitted) return submitted.id;
      const savedUser = event.type === "message_end" ? session.messages.find(message => message.timestamp === normalized.timestamp && sameUserContent(message, normalized)) : undefined;

      if (savedUser) return savedUser.id;
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

      if (rawMessage.role === "custom" && rawMessage.display === false && !isContextInjection(rawMessage)) return;
      const normalized = normalizeMessage(rawMessage);
      const liveId = messageLiveId(rawMessage, roleKey, normalized);

      if (event.type === "message_start") trackLiveId(roleKey, liveId); else activeMessageIds.current.delete(roleKey);
      let message = { ...normalized, id: liveId };

      message = updateAssistant(message);
      session.setMessages(current => upsertLiveMessage(current, message));
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
      "thinking_level_changed": handleThinkingLevelChanged,
      "model_select": () => { if (!transport().promptControls?.isApplying()) refreshCapabilities(); }
    }));

    handlers.get(event.type)?.();
    advanceRevision(event);
  };

  createComputed(() => { eventHandler.current = handleEvent; });

  return { get capabilityErrors() { return capabilityErrors(); }, get capabilitiesLoading() { return capabilitiesLoading(); }, get retryCapabilities() { return refreshCapabilities; }, get state() { return session.state; }, get setState() { return session.setState; }, get messages() { return session.messages; }, get setMessages() { return session.setMessages; }, get models() { return session.models; }, get commands() { return session.commands; }, get thinkingLevels() { return session.thinkingLevels; }, get refresh() { return refresh; }, get handleEvent() { return handleEvent; }, get discardPendingUpdates() { return discardPendingUpdates; } };
}
