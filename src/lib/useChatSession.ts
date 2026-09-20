import { mergeSpokenMessages, voiceEntry } from "./voiceMessages";
import { useCallback, useEffect, useRef } from "react";
import { useSessionMemory } from "./sessionMemory";
import type { AgentState, ChatMessage, Model, PromptContextInfo, RpcEvent, SlashCommand } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { appendFileChanges, applyAssistantMessageEvent, branchMessages, checkpointLatestUser, isResumeMessage, normalizeMessage, resumeMarker, type PiEntry } from "./messages";
import { contextUsageAfterCompaction } from "./contextUsage";

interface SessionSnapshot { revision: string; state: AgentState; history: { entries: PiEntry[]; leafId: string | null; omittedEntries?: number }; sequence: number; epoch: string; liveTools: RpcEvent[]; queue: RpcEvent; }
type MessageUpdate = (messages: ChatMessage[]) => ChatMessage[];
const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };

export function useChatSession(transport: Pick<NativeTransport, "command" | "subscribe"> & Partial<Pick<NativeTransport, "ownsConversation">>, initialState: AgentState = emptyState) {
  const { state, setState, messages, setMessages, models, setModels, commands, setCommands, thinkingLevels, setThinkingLevels, memory } = useSessionMemory(transport, initialState);
  const owner = useRef(transport); owner.current = transport;
  const capabilityRequest = useRef(0);
  const refreshOperation = useRef<{ transport: typeof transport; promise: Promise<AgentState>; buffer: RpcEvent[] } | undefined>(undefined);
  const bufferedEvents = useRef<RpcEvent[] | undefined>(undefined);
  const eventHandler = useRef<(event: RpcEvent) => void>(() => undefined);
  const resumeMarkers = useRef(new Set<string>());
  const liveRevision = useRef(0); const activeAssistantId = useRef<string | undefined>(undefined); const activeMessageIds = useRef(new Map<string, string>()); const liveMessageSequence = useRef(0); const pendingUpdates = useRef<MessageUpdate[]>([]); const frame = useRef<number | undefined>(undefined);
  const nextLiveMessageId = (role: unknown) => `live-${String(role).slice(0, 32)}-${Date.now()}-${++liveMessageSequence.current}`;
  const trackLiveId = (roleKey: string, liveId: string) => {
    // Role strings are backend-controlled; cap the registry so distinct
    // unended roles cannot grow it without bound (F-052).
    if (activeMessageIds.current.size >= 32 && !activeMessageIds.current.has(roleKey)) {
      const oldest = activeMessageIds.current.keys().next();
      if (!oldest.done) activeMessageIds.current.delete(oldest.value);
    }
    activeMessageIds.current.set(roleKey, liveId);
  };
  const flush = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; const updates = pendingUpdates.current.splice(0); if (updates.length) setMessages((current) => updates.reduce((next, update) => update(next), current)); }, [setMessages]);
  const queue = useCallback((update: MessageUpdate) => { pendingUpdates.current.push(update); if (frame.current === undefined) frame.current = requestAnimationFrame(flush); }, [flush]);
  const discardPendingUpdates = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; pendingUpdates.current.length = 0; }, []);
  useEffect(() => discardPendingUpdates, [discardPendingUpdates]);
  useEffect(() => { liveRevision.current += 1; activeAssistantId.current = undefined; activeMessageIds.current.clear(); resumeMarkers.current.clear(); bufferedEvents.current = undefined; discardPendingUpdates(); }, [discardPendingUpdates, transport]);

  const refresh = useCallback((): Promise<AgentState> => {
    if (owner.current !== transport) return Promise.reject(new Error("Conversation changed"));
    if (refreshOperation.current?.transport === transport) return refreshOperation.current.promise;
    const buffer: RpcEvent[] = []; bufferedEvents.current = buffer;
    const restoreHistory = (snapshot: SessionSnapshot) => {
      for (const entry of snapshot.history.entries) { const marker = resumeMarker(entry); if (marker) resumeMarkers.current.add(marker); }
      const previous = new Map(memory.getSnapshot().messages.filter((message) => message.toolPayloadLoaded && message.toolStatus !== "running").map((message) => [message.deferredToolPayload, message]));
      const nextMessages = branchMessages(snapshot.history.entries, snapshot.history.leafId).map((message) => {
        const cached = previous.get(message.deferredToolPayload);
        return cached ? { ...message, content: cached.content, details: cached.details, toolInput: cached.toolInput, toolPayloadLoaded: true, loadToolPayload: cached.loadToolPayload } : message;
      });
      if (snapshot.history.omittedEntries) nextMessages.unshift({ id: "client-memory-limit", role: "system", content: "Older history was omitted to fit this client's memory limit. The full conversation remains on the host." });
      activeAssistantId.current = [...nextMessages].reverse().find((message) => message.role === "assistant" && message.streaming)?.id;
      activeMessageIds.current.clear();
      for (const message of nextMessages.filter((message) => message.streaming)) trackLiveId(message.role, message.id);
      setMessages(nextMessages);
    };
    const restoreCapabilities = (modelResult?: { models: Model[] }, thinkingResult?: { levels: string[] }, commandResult?: { commands: SlashCommand[] }) => {
      if (modelResult) setModels(modelResult.models);
      if (thinkingResult) setThinkingLevels(thinkingResult.levels);
      if (commandResult) {
        const visible = commandResult.commands.filter((command) => command.sourceInfo?.source !== "inline" && !command.name.startsWith("pi-orchestration-") && !["pi-desktop-control", "pi-desktop-fast-status", "pi-desktop-fork-and-forget", "pi-desktop-voice-history"].includes(command.name));
        setCommands(visible.some((command) => command.name === "compact") ? visible : [{ name: "compact", description: "Compact conversation context", source: "builtin" }, ...visible]);
      }
    };
    const replaySnapshotEvents = (snapshot: SessionSnapshot) => {
      for (const event of snapshot.liveTools) { eventHandler.current(event); if (event.partialResult) eventHandler.current({ ...event, type: "tool_execution_update" }); }
      for (const event of buffer) if (typeof event.sequence !== "number" || (event.epoch === snapshot.epoch && event.sequence > snapshot.sequence)) eventHandler.current(event);
    };
    const finishRefresh = () => {
      if (bufferedEvents.current === buffer) { bufferedEvents.current = undefined; if (owner.current === transport) for (const event of buffer) eventHandler.current(event); }
      if (refreshOperation.current?.buffer === buffer) refreshOperation.current = undefined;
    };
    const promise = (async () => {
      try {
        const { revision } = await transport.command<{ revision: string }>({ type: "get_session_revision" });
        if (owner.current !== transport) throw new Error("Conversation changed");
        if (memory.revision === revision) {
          for (const message of memory.getSnapshot().messages.filter((message) => message.streaming)) trackLiveId(message.role, message.id);
          activeAssistantId.current = [...memory.getSnapshot().messages].reverse().find((message) => message.role === "assistant" && message.streaming)?.id;
          return memory.getSnapshot().state;
        }
        const request = ++capabilityRequest.current;
        const snapshotRequest = transport.command<SessionSnapshot>({ type: "get_snapshot" });
        const capabilities = () => Promise.all([
          transport.command<{ models: Model[] }>({ type: "get_available_models" }).catch(() => undefined),
          transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }).catch(() => undefined),
          transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" }).catch(() => undefined),
          transport.command<{ contextUsage?: AgentState["contextUsage"] }>({ type: "get_session_stats" }).catch(() => undefined),
        ]);
        const snapshot = await snapshotRequest;
        if (owner.current !== transport || bufferedEvents.current !== buffer) throw new Error("Conversation changed");
        if (buffer.some((event) => (event.type === "session_switched" && event.epoch !== snapshot.epoch) || (event.type === "session_info_changed" && Number(event.sequence) > snapshot.sequence))) {
          refreshOperation.current = undefined; bufferedEvents.current = undefined;
          return refresh();
        }
        discardPendingUpdates();
        memory.batch(() => {
          restoreHistory(snapshot);
          setState({ ...snapshot.state, pendingMessages: snapshot.queue.pendingMessages as AgentState["pendingMessages"] });
        });
        memory.markRevision(snapshot.revision);
        bufferedEvents.current = undefined;
        replaySnapshotEvents(snapshot);
        void capabilities().then(([modelResult, thinkingResult, commandResult, statsResult]) => {
          if (owner.current !== transport || capabilityRequest.current !== request || !memory.revision) return;
          memory.batch(() => {
            restoreCapabilities(modelResult, thinkingResult, commandResult);
            if (statsResult) setState((current) => ({ ...current, contextUsage: statsResult.contextUsage }));
          });
        }).catch(() => undefined);
        return snapshot.state;
      } finally {
        finishRefresh();
      }
    })();
    refreshOperation.current = { transport, promise, buffer };
    return promise;
  }, [discardPendingUpdates, transport, memory, setMessages, setState, setModels, setCommands, setThinkingLevels]);

  useEffect(() => {
    let stopped = false;
    let viewing = transport.ownsConversation?.() === false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { await refresh(); } catch { /* Reconnect or the next refresh will retry. */ }
      if (!stopped && viewing) timer = setTimeout(() => void poll(), 2000);
    };
    const unsubscribe = transport.subscribe((event) => {
      if (event.type === "ownership_lost" && !viewing) { viewing = true; void poll(); }
      if (event.type === "ownership_acquired" || event.type === "disconnected") { viewing = false; clearTimeout(timer); }
    });
    if (viewing) void poll();
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
  }, [refresh, transport]);

  const handleEvent = useCallback((event: RpcEvent) => {
    if (owner.current !== transport) return;
    if (bufferedEvents.current) { bufferedEvents.current.push(event); return; }
    if (["agent_start", "agent_end", "agent_settled", "pause_state", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) liveRevision.current += 1;
    const handleRuntimePresence = () => {
      setState((current) => ({ ...current, viewers: Number(event.viewers), isStreaming: event.isStreaming === true }));
    };
    const handleExtensionUiRequest = () => {
      if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-desktop-prompt-context" && typeof event.statusText === "string" && event.statusText.startsWith("json:")) {
        try {
          const context = JSON.parse(event.statusText.slice(5)) as PromptContextInfo;
          if (typeof context.userTimestamp === "number") {
            liveRevision.current += 1;
            setMessages((current) => current.map((message) => message.role === "user" && message.timestamp === context.userTimestamp && !message.promptContext ? { ...message, promptContext: context } : message));
          }
        } catch { /* Ignore malformed extension status data. */ }
      }
    };
    const handleEntryAppended = () => {
      if (event.type === "entry_appended" && event.entry) { const entry = event.entry as PiEntry; const voice = voiceEntry(entry); if (voice) { liveRevision.current += 1; setMessages((current) => mergeSpokenMessages(current, [voice])); } const marker = resumeMarker(entry); if (marker) { resumeMarkers.current.add(marker); setMessages(checkpointLatestUser); } if (entry.customType === "piop-file-changes") { liveRevision.current += 1; setMessages((current) => appendFileChanges(current, entry)); } }
    };
    const handleAgentStart = () => {
      setState((current) => ({ ...current, isStreaming: true, isPaused: false }));
    };
    const handlePauseState = () => {
      setState((current) => ({ ...current, isPaused: event.isPaused === true, isPausing: event.isPausing === true, ...(event.isPaused === true && event.isPausing !== true ? { isStreaming: false, activity: undefined } : {}) }));
      if (event.type === "pause_state" && event.isPaused === true && event.isPausing !== true) { flush(); setMessages(checkpointLatestUser); }
    };
    const handleAgentSettled = () => {
      setState((current) => ({ ...current, isStreaming: false, activity: undefined }));
    };
    const handleDisconnected = () => {
      setState((current) => ({ ...current, isStreaming: false, isPausing: false, activity: undefined }));
    };
    const messageLiveId = (rawMessage: Record<string, unknown>, roleKey: string) => {
      const toolCallId = rawMessage.toolCallId;
      return rawMessage.role === "toolResult" && typeof toolCallId === "string" ? toolCallId : event.type === "message_start" ? nextLiveMessageId(roleKey) : activeMessageIds.current.get(roleKey) ?? nextLiveMessageId(roleKey);
    };
    const updateAssistant = (message: ChatMessage) => {
      if (message.role === "assistant" && event.type === "message_start") { message = { ...message, streaming: true }; activeAssistantId.current = message.id; }
      if (message.role === "assistant" && event.type === "message_end") { message = { ...message, ...(activeAssistantId.current ? { id: activeAssistantId.current } : {}), completedAt: Date.now(), streaming: false }; activeAssistantId.current = undefined; }
      return message;
    };
    const handleMessageStart = () => {
      if (event.type === "message_end") flush();
      const rawMessage = (event.message ?? {}) as Record<string, unknown>; const roleKey = String((rawMessage as { role?: unknown }).role ?? "message");
      if (isResumeMessage(rawMessage, resumeMarkers.current)) return;
      if (rawMessage.role === "custom" && (rawMessage as { display?: unknown }).display === false) return;
      const liveId = messageLiveId(rawMessage, roleKey);
      if (event.type === "message_start") trackLiveId(roleKey, liveId); else activeMessageIds.current.delete(roleKey);
      let message = normalizeMessage(rawMessage, undefined, undefined, liveId);
      if (message.customType === "pi-desktop-btw") return;
      message = updateAssistant(message);
      setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? { ...message, toolInput: message.toolInput ?? item.toolInput, details: message.details ?? item.details, fileChanges: item.fileChanges, promptContext: item.promptContext } : item) : [...current, message]);
    };
    const handleMessageUpdate = () => {
      if (event.assistantMessageEvent) queue((current) => { let index = -1; for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) { const message = current[candidate]; if (message.role === "assistant" && (message.id === activeAssistantId.current || message.streaming)) { index = candidate; break; } } if (index < 0) return current; const next = [...current]; next[index] = applyAssistantMessageEvent(next[index], event.assistantMessageEvent); return next; });
      else if (event.message) { const rawMessage = (event.message ?? {}) as Record<string, unknown>; const roleKey = String((rawMessage as { role?: unknown }).role ?? "message"); let liveId = activeMessageIds.current.get(roleKey); if (!liveId) { liveId = nextLiveMessageId(roleKey); trackLiveId(roleKey, liveId); } const message = { ...normalizeMessage(rawMessage, undefined, undefined, liveId), streaming: true }; queue((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]); }
    };
    const handleToolExecutionStart = () => {
      const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: String(event.toolName), toolStatus: "running", content: "", timestamp: Date.now() };
      setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
    };
    const handleToolExecutionUpdate = () => {
      queue((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: "", details: undefined, toolPayloadLoaded: false, toolPayloadVersion: Number(event.sequence), toolStatus: "running" } : item));
    };
    const handleToolExecutionEnd = () => {
      flush();
      setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: "", details: undefined, toolPayloadLoaded: false, toolPayloadVersion: Number(event.sequence), toolStatus: event.isError ? "error" : "done" } : item));
    };
    const handleQueueUpdate = () => {
      setState((current) => ({ ...current, pendingMessages: event.pendingMessages as AgentState["pendingMessages"], pendingMessageCount: [...((event.steering as unknown[]) ?? []), ...((event.followUp as unknown[]) ?? [])].length }));
    };
    const handleCompactionStart = () => {
      setState((current) => ({ ...current, activity: "Compacting context…" }));
    };
    const handleCompactionEnd = () => {
      setState((current) => ({ ...current, activity: undefined, contextUsage: contextUsageAfterCompaction(current.contextUsage, event) }));
    };
    const handleAutoRetryStart = () => {
      setState((current) => ({ ...current, activity: `Retrying · attempt ${event.attempt}` }));
    };
    const handleThinkingLevelChanged = () => {
      if (event.type === "thinking_level_changed" && typeof event.level === "string") setState((current) => ({ ...current, thinkingLevel: event.level as string }));
    };
    const handlers: Record<string, () => void> = {
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
      "compaction_end": handleCompactionEnd,
      "auto_retry_start": handleAutoRetryStart,
      "thinking_level_changed": handleThinkingLevelChanged
    };
    if (Object.hasOwn(handlers, event.type)) handlers[event.type]();
    if (typeof event.revision === "string" && memory.revision === event.previousRevision && !["session_info_changed", "session_switched", "settings_applied", "disconnected", "model_select"].includes(event.type)) {
      flush();
      memory.markRevision(event.revision);
    }
  }, [flush, queue, transport, setState, setMessages, memory]);

  eventHandler.current = handleEvent;
  return { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh, handleEvent, discardPendingUpdates };
}
