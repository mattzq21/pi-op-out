import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState, ChatMessage, Model, PromptContextInfo, RpcEvent, SlashCommand } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { applyAssistantMessageEvent, branchMessages, checkpointLatestUser, isResumeMessage, normalizeMessage, resumeMarker, type PiEntry } from "./messages";
import { contextUsageAfterCompaction } from "./contextUsage";

type MessageUpdate = (messages: ChatMessage[]) => ChatMessage[];
const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };
const rpcContent = (value: unknown): ChatMessage["content"] => (value as { content?: ChatMessage["content"] })?.content ?? "";

export function useChatSession(transport: Pick<NativeTransport, "command" | "subscribe">, initialState: AgentState = emptyState) {
  const [state, setState] = useState(initialState); const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [commands, setCommands] = useState<SlashCommand[]>([]); const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]);
  const owner = useRef(transport); owner.current = transport;
  const resumeMarkers = useRef(new Set<string>());
  const liveRevision = useRef(0); const activeAssistantId = useRef<string | undefined>(undefined); const activeMessageIds = useRef(new Map<string, string>()); const liveMessageSequence = useRef(0); const pendingUpdates = useRef<MessageUpdate[]>([]); const frame = useRef<number | undefined>(undefined);
  const nextLiveMessageId = (role: unknown) => `live-${String(role)}-${Date.now()}-${++liveMessageSequence.current}`;
  const flush = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; const updates = pendingUpdates.current.splice(0); if (updates.length) setMessages((current) => updates.reduce((next, update) => update(next), current)); }, []);
  const queue = useCallback((update: MessageUpdate) => { pendingUpdates.current.push(update); if (frame.current === undefined) frame.current = requestAnimationFrame(flush); }, [flush]);
  const discardPendingUpdates = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; pendingUpdates.current.length = 0; }, []);
  useEffect(() => discardPendingUpdates, [discardPendingUpdates]);
  useEffect(() => { liveRevision.current += 1; activeAssistantId.current = undefined; activeMessageIds.current.clear(); resumeMarkers.current.clear(); discardPendingUpdates(); }, [discardPendingUpdates, transport]);

  const refresh = useCallback(async () => {
    if (owner.current !== transport) throw new Error("Conversation changed");
    const revision = liveRevision.current;
    const [stateResult, historyResult, modelResult, thinkingResult, commandResult, statsResult] = await Promise.allSettled([
      transport.command<AgentState>({ type: "get_state" }), transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }), transport.command<{ models: Model[] }>({ type: "get_available_models" }), transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }), transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" }), transport.command<{ contextUsage?: AgentState["contextUsage"] }>({ type: "get_session_stats" })
    ] as const);
    if (owner.current !== transport) throw new Error("Conversation changed");
    if (stateResult.status === "rejected") throw stateResult.reason;
    if (historyResult.status === "rejected") throw historyResult.reason;
    const nextState = stateResult.value;
    if (modelResult.status === "fulfilled") setModels(modelResult.value.models);
    if (thinkingResult.status === "fulfilled") setThinkingLevels(thinkingResult.value.levels);
    if (liveRevision.current !== revision) {
      setState((current) => ({ ...nextState, ...current, model: nextState.model, thinkingLevel: nextState.thinkingLevel, sessionId: nextState.sessionId, sessionFile: nextState.sessionFile }));
      setMessages((current) => current.length ? current : branchMessages(historyResult.value.entries, historyResult.value.leafId));
    }
    if (liveRevision.current === revision) {
      discardPendingUpdates();
      setState((current) => ({ ...nextState, pendingMessages: current.pendingMessages, ...(statsResult.status === "fulfilled" ? { contextUsage: statsResult.value.contextUsage } : {}) }));
      if (historyResult.status === "fulfilled") { for (const entry of historyResult.value.entries) { const marker = resumeMarker(entry); if (marker) resumeMarkers.current.add(marker); } setMessages(branchMessages(historyResult.value.entries, historyResult.value.leafId)); }
      if (modelResult.status === "fulfilled") setModels(modelResult.value.models);
      if (thinkingResult.status === "fulfilled") setThinkingLevels(thinkingResult.value.levels);
      if (commandResult.status === "fulfilled") { const visibleCommands = commandResult.value.commands.filter((command) => command.sourceInfo?.source !== "inline" && !command.name.startsWith("pi-orchestration-") && !["pi-desktop-control", "pi-desktop-fast-status"].includes(command.name)); setCommands(visibleCommands.some((command) => command.name === "compact") ? visibleCommands : [{ name: "compact", description: "Compact conversation context", source: "builtin" }, ...visibleCommands]); }
    }
    return nextState;
  }, [discardPendingUpdates, transport]);

  const handleEvent = useCallback((event: RpcEvent) => {
    if (owner.current !== transport) return;
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-desktop-prompt-context" && typeof event.statusText === "string" && event.statusText.startsWith("json:")) {
      try {
        const context = JSON.parse(event.statusText.slice(5)) as PromptContextInfo;
        if (typeof context.userTimestamp === "number") {
          liveRevision.current += 1;
          setMessages((current) => current.map((message) => message.role === "user" && message.timestamp === context.userTimestamp && !message.promptContext ? { ...message, promptContext: context } : message));
        }
      } catch { /* Ignore malformed extension status data. */ }
    }
    if (event.type === "entry_appended" && event.entry) { const marker = resumeMarker(event.entry as PiEntry); if (marker) { resumeMarkers.current.add(marker); setMessages(checkpointLatestUser); } }
    if (["agent_start", "agent_end", "agent_settled", "pause_state", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) liveRevision.current += 1;
    if (event.type === "agent_start") setState((current) => ({ ...current, isStreaming: true, isPaused: false }));
    if (event.type === "pause_state") setState((current) => ({ ...current, isPaused: event.isPaused === true, isPausing: event.isPausing === true, ...(event.isPaused === true && event.isPausing !== true ? { isStreaming: false, activity: undefined } : {}) }));
    if (event.type === "pause_state" && event.isPaused === true && event.isPausing !== true) { flush(); setMessages(checkpointLatestUser); }
    if (event.type === "agent_settled") setState((current) => ({ ...current, isStreaming: false, activity: undefined }));
    if (event.type === "disconnected") setState((current) => ({ ...current, isStreaming: false, isPausing: false, activity: undefined }));
    if (event.type === "message_start" || event.type === "message_end") {
      if (event.type === "message_end") flush();
      const rawMessage = event.message as Record<string, unknown>; const roleKey = String(rawMessage.role ?? "message");
      if (isResumeMessage(rawMessage, resumeMarkers.current)) return;
      if (rawMessage.role === "custom" && rawMessage.display === false) return;
      const liveId = rawMessage.role === "toolResult" && typeof rawMessage.toolCallId === "string" ? rawMessage.toolCallId : event.type === "message_start" ? nextLiveMessageId(roleKey) : activeMessageIds.current.get(roleKey) ?? nextLiveMessageId(roleKey);
      if (event.type === "message_start") activeMessageIds.current.set(roleKey, liveId); else activeMessageIds.current.delete(roleKey);
      let message = normalizeMessage(rawMessage, undefined, undefined, liveId);
      if (message.customType === "pi-desktop-btw") return;
      if (message.role === "assistant" && event.type === "message_start") { message = { ...message, streaming: true }; activeAssistantId.current = message.id; }
      if (message.role === "assistant" && event.type === "message_end") { message = { ...message, ...(activeAssistantId.current ? { id: activeAssistantId.current } : {}), completedAt: Date.now(), streaming: false }; activeAssistantId.current = undefined; }
      setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? { ...message, toolInput: message.toolInput ?? item.toolInput, promptContext: item.promptContext } : item) : [...current, message]);
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent) queue((current) => { let index = -1; for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) { const message = current[candidate]; if (message.role === "assistant" && (message.id === activeAssistantId.current || message.streaming)) { index = candidate; break; } } if (index < 0) return current; const next = [...current]; next[index] = applyAssistantMessageEvent(next[index], event.assistantMessageEvent); return next; });
      else if (event.message) { const rawMessage = event.message as Record<string, unknown>; const roleKey = String(rawMessage.role ?? "message"); let liveId = activeMessageIds.current.get(roleKey); if (!liveId) { liveId = nextLiveMessageId(roleKey); activeMessageIds.current.set(roleKey, liveId); } const message = { ...normalizeMessage(rawMessage, undefined, undefined, liveId), streaming: true }; queue((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]); }
    }
    if (event.type === "tool_execution_start") { const target = event.toolName === "call_agent" && event.args && typeof event.args === "object" ? String((event.args as { target?: unknown }).target ?? "") : ""; const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: target ? `${target} called` : String(event.toolName), toolStatus: "running", toolInput: event.args ?? {}, content: "", timestamp: Date.now() }; setMessages((current) => [...current.filter((item) => item.id !== message.id), message]); }
    if (event.type === "tool_execution_update") queue((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.partialResult), toolStatus: "running" } : item));
    if (event.type === "tool_execution_end") { flush(); setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.result), toolStatus: event.isError ? "error" : "done" } : item)); }
    if (event.type === "queue_update") setState((current) => ({ ...current, pendingMessages: event.pendingMessages as AgentState["pendingMessages"], pendingMessageCount: [...((event.steering as unknown[]) ?? []), ...((event.followUp as unknown[]) ?? [])].length }));
    if (event.type === "compaction_start") setState((current) => ({ ...current, activity: "Compacting context…" }));
    if (event.type === "compaction_end") setState((current) => ({ ...current, activity: undefined, contextUsage: contextUsageAfterCompaction(current.contextUsage, event) }));
    if (event.type === "auto_retry_start") setState((current) => ({ ...current, activity: `Retrying · attempt ${event.attempt}` }));
    if (event.type === "thinking_level_changed" && typeof event.level === "string") setState((current) => ({ ...current, thinkingLevel: event.level as string }));
  }, [flush, queue, transport]);

  return { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh, handleEvent, discardPendingUpdates };
}
