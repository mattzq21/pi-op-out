import { mergeSpokenMessages, voiceEntry } from "./voiceMessages";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState, ChatMessage, Model, PromptContextInfo, RpcEvent, SlashCommand } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { appendFileChanges, applyAssistantMessageEvent, branchMessages, checkpointLatestUser, isResumeMessage, normalizeMessage, resumeMarker, type PiEntry } from "./messages";
import { contextUsageAfterCompaction } from "./contextUsage";

interface SessionSnapshot { state: AgentState; history: { entries: PiEntry[]; leafId: string | null }; sequence: number; epoch: string; liveTools: RpcEvent[]; queue: RpcEvent; }
type MessageUpdate = (messages: ChatMessage[]) => ChatMessage[];
const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };
const rpcContent = (value: unknown): ChatMessage["content"] => (value as { content?: ChatMessage["content"] })?.content ?? "";

export function useChatSession(transport: Pick<NativeTransport, "command" | "subscribe">, initialState: AgentState = emptyState) {
  const [state, setState] = useState(initialState); const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [commands, setCommands] = useState<SlashCommand[]>([]); const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]);
  const owner = useRef(transport); owner.current = transport;
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
  const flush = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; const updates = pendingUpdates.current.splice(0); if (updates.length) setMessages((current) => updates.reduce((next, update) => update(next), current)); }, []);
  const queue = useCallback((update: MessageUpdate) => { pendingUpdates.current.push(update); if (frame.current === undefined) frame.current = requestAnimationFrame(flush); }, [flush]);
  const discardPendingUpdates = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; pendingUpdates.current.length = 0; }, []);
  useEffect(() => discardPendingUpdates, [discardPendingUpdates]);
  useEffect(() => { liveRevision.current += 1; activeAssistantId.current = undefined; activeMessageIds.current.clear(); resumeMarkers.current.clear(); bufferedEvents.current = undefined; discardPendingUpdates(); }, [discardPendingUpdates, transport]);

  const refresh = useCallback((): Promise<AgentState> => {
    if (owner.current !== transport) return Promise.reject(new Error("Conversation changed"));
    if (refreshOperation.current?.transport === transport) return refreshOperation.current.promise;
    const buffer: RpcEvent[] = []; bufferedEvents.current = buffer;
    const promise = (async () => {
      try {
        const [snapshot, modelResult, thinkingResult, commandResult, statsResult] = await Promise.all([
          transport.command<SessionSnapshot>({ type: "get_snapshot" }),
          transport.command<{ models: Model[] }>({ type: "get_available_models" }).catch(() => undefined),
          transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }).catch(() => undefined),
          transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" }).catch(() => undefined),
          transport.command<{ contextUsage?: AgentState["contextUsage"] }>({ type: "get_session_stats" }).catch(() => undefined),
        ]);
        if (owner.current !== transport || bufferedEvents.current !== buffer) throw new Error("Conversation changed");
        if (buffer.some((event) => (event.type === "session_switched" && event.epoch !== snapshot.epoch) || (event.type === "session_info_changed" && Number(event.sequence) > snapshot.sequence))) {
          refreshOperation.current = undefined; bufferedEvents.current = undefined;
          return refresh();
        }
        discardPendingUpdates();
        for (const entry of snapshot.history.entries) { const marker = resumeMarker(entry); if (marker) resumeMarkers.current.add(marker); }
        const nextMessages = branchMessages(snapshot.history.entries, snapshot.history.leafId);
        activeAssistantId.current = [...nextMessages].reverse().find((message) => message.role === "assistant" && message.streaming)?.id;
        activeMessageIds.current.clear();
        for (const message of nextMessages.filter((message) => message.streaming)) trackLiveId(message.role, message.id);
        setMessages(nextMessages);
        setState({ ...snapshot.state, pendingMessages: snapshot.queue.pendingMessages as AgentState["pendingMessages"], ...(statsResult ? { contextUsage: statsResult.contextUsage } : {}) });
        if (modelResult) setModels(modelResult.models);
        if (thinkingResult) setThinkingLevels(thinkingResult.levels);
        if (commandResult) {
          const visible = commandResult.commands.filter((command) => command.sourceInfo?.source !== "inline" && !command.name.startsWith("pi-orchestration-") && !["pi-desktop-control", "pi-desktop-fast-status", "pi-desktop-fork-and-forget", "pi-desktop-voice-history"].includes(command.name));
          setCommands(visible.some((command) => command.name === "compact") ? visible : [{ name: "compact", description: "Compact conversation context", source: "builtin" }, ...visible]);
        }
        bufferedEvents.current = undefined;
        for (const event of snapshot.liveTools) { eventHandler.current(event); if (event.partialResult) eventHandler.current({ ...event, type: "tool_execution_update" }); }
        for (const event of buffer) if (typeof event.sequence !== "number" || (event.epoch === snapshot.epoch && event.sequence > snapshot.sequence)) eventHandler.current(event);
        return snapshot.state;
      } finally {
        if (bufferedEvents.current === buffer) { bufferedEvents.current = undefined; if (owner.current === transport) for (const event of buffer) eventHandler.current(event); }
        if (refreshOperation.current?.buffer === buffer) refreshOperation.current = undefined;
      }
    })();
    refreshOperation.current = { transport, promise, buffer };
    return promise;
  }, [discardPendingUpdates, transport]);

  const handleEvent = useCallback((event: RpcEvent) => {
    if (owner.current !== transport) return;
    if (bufferedEvents.current) { bufferedEvents.current.push(event); return; }
    if (event.type === "runtime_presence") setState((current) => ({ ...current, viewers: Number(event.viewers), isStreaming: event.isStreaming === true }));
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-desktop-prompt-context" && typeof event.statusText === "string" && event.statusText.startsWith("json:")) {
      try {
        const context = JSON.parse(event.statusText.slice(5)) as PromptContextInfo;
        if (typeof context.userTimestamp === "number") {
          liveRevision.current += 1;
          setMessages((current) => current.map((message) => message.role === "user" && message.timestamp === context.userTimestamp && !message.promptContext ? { ...message, promptContext: context } : message));
        }
      } catch { /* Ignore malformed extension status data. */ }
    }
    if (event.type === "entry_appended" && event.entry) { const entry = event.entry as PiEntry; const voice = voiceEntry(entry); if (voice) { liveRevision.current += 1; setMessages((current) => mergeSpokenMessages(current, [voice])); } const marker = resumeMarker(entry); if (marker) { resumeMarkers.current.add(marker); setMessages(checkpointLatestUser); } if (entry.customType === "piop-file-changes") { liveRevision.current += 1; setMessages((current) => appendFileChanges(current, entry)); } }
    if (["agent_start", "agent_end", "agent_settled", "pause_state", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) liveRevision.current += 1;
    if (event.type === "agent_start") setState((current) => ({ ...current, isStreaming: true, isPaused: false }));
    if (event.type === "pause_state") setState((current) => ({ ...current, isPaused: event.isPaused === true, isPausing: event.isPausing === true, ...(event.isPaused === true && event.isPausing !== true ? { isStreaming: false, activity: undefined } : {}) }));
    if (event.type === "pause_state" && event.isPaused === true && event.isPausing !== true) { flush(); setMessages(checkpointLatestUser); }
    if (event.type === "agent_settled") setState((current) => ({ ...current, isStreaming: false, activity: undefined }));
    if (event.type === "disconnected") setState((current) => ({ ...current, isStreaming: false, isPausing: false, activity: undefined }));
    if (event.type === "message_start" || event.type === "message_end") {
      if (event.type === "message_end") flush();
      const rawMessage = (event.message ?? {}) as Record<string, unknown>; const roleKey = String((rawMessage as { role?: unknown }).role ?? "message");
      if (isResumeMessage(rawMessage, resumeMarkers.current)) return;
      if (rawMessage.role === "custom" && (rawMessage as { display?: unknown }).display === false) return;
      const toolCallId = (rawMessage as { toolCallId?: unknown }).toolCallId;
      const liveId = rawMessage.role === "toolResult" && typeof toolCallId === "string" ? toolCallId : event.type === "message_start" ? nextLiveMessageId(roleKey) : activeMessageIds.current.get(roleKey) ?? nextLiveMessageId(roleKey);
      if (event.type === "message_start") trackLiveId(roleKey, liveId); else activeMessageIds.current.delete(roleKey);
      let message = normalizeMessage(rawMessage, undefined, undefined, liveId);
      if (message.customType === "pi-desktop-btw") return;
      if (message.role === "assistant" && event.type === "message_start") { message = { ...message, streaming: true }; activeAssistantId.current = message.id; }
      if (message.role === "assistant" && event.type === "message_end") { message = { ...message, ...(activeAssistantId.current ? { id: activeAssistantId.current } : {}), completedAt: Date.now(), streaming: false }; activeAssistantId.current = undefined; }
      setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? { ...message, toolInput: message.toolInput ?? item.toolInput, details: message.details ?? item.details, fileChanges: item.fileChanges, promptContext: item.promptContext } : item) : [...current, message]);
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent) queue((current) => { let index = -1; for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) { const message = current[candidate]; if (message.role === "assistant" && (message.id === activeAssistantId.current || message.streaming)) { index = candidate; break; } } if (index < 0) return current; const next = [...current]; next[index] = applyAssistantMessageEvent(next[index], event.assistantMessageEvent); return next; });
      else if (event.message) { const rawMessage = (event.message ?? {}) as Record<string, unknown>; const roleKey = String((rawMessage as { role?: unknown }).role ?? "message"); let liveId = activeMessageIds.current.get(roleKey); if (!liveId) { liveId = nextLiveMessageId(roleKey); trackLiveId(roleKey, liveId); } const message = { ...normalizeMessage(rawMessage, undefined, undefined, liveId), streaming: true }; queue((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]); }
    }
    if (event.type === "tool_execution_start") { const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: String(event.toolName), toolStatus: "running", toolInput: event.args ?? {}, content: "", timestamp: Date.now() }; setMessages((current) => [...current.filter((item) => item.id !== message.id), message]); }
    if (event.type === "tool_execution_update") queue((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.partialResult), toolStatus: "running" } : item));
    if (event.type === "tool_execution_end") { flush(); setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.result), details: (event.result as { details?: unknown })?.details, toolStatus: event.isError ? "error" : "done" } : item)); }
    if (event.type === "queue_update") setState((current) => ({ ...current, pendingMessages: event.pendingMessages as AgentState["pendingMessages"], pendingMessageCount: [...((event.steering as unknown[]) ?? []), ...((event.followUp as unknown[]) ?? [])].length }));
    if (event.type === "compaction_start") setState((current) => ({ ...current, activity: "Compacting context…" }));
    if (event.type === "compaction_end") setState((current) => ({ ...current, activity: undefined, contextUsage: contextUsageAfterCompaction(current.contextUsage, event) }));
    if (event.type === "auto_retry_start") setState((current) => ({ ...current, activity: `Retrying · attempt ${event.attempt}` }));
    if (event.type === "thinking_level_changed" && typeof event.level === "string") setState((current) => ({ ...current, thinkingLevel: event.level as string }));
  }, [flush, queue, transport]);

  eventHandler.current = handleEvent;
  return { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh, handleEvent, discardPendingUpdates };
}
