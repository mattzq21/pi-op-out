import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentState, ChatMessage, Model, PiTransport, RpcEvent, SlashCommand } from "../types";
import { applyAssistantMessageEvent, branchMessages, normalizeMessage, type PiEntry } from "./messages";

type MessageUpdate = (messages: ChatMessage[]) => ChatMessage[];
const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };
const rpcContent = (value: unknown): ChatMessage["content"] => (value as { content?: ChatMessage["content"] })?.content ?? "";

export interface ChatSessionRuntime {
  state: AgentState;
  setState: Dispatch<SetStateAction<AgentState>>;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  models: Model[];
  commands: SlashCommand[];
  thinkingLevels: string[];
  refresh: () => Promise<AgentState>;
  handleEvent: (event: RpcEvent) => void;
  discardPendingUpdates: () => void;
}

export function useChatSession(transport: PiTransport, initialState: AgentState = emptyState): ChatSessionRuntime {
  const [state, setState] = useState(initialState); const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [commands, setCommands] = useState<SlashCommand[]>([]); const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]);
  const liveRevision = useRef(0); const activeAssistantId = useRef<string | undefined>(undefined); const pendingUpdates = useRef<MessageUpdate[]>([]); const frame = useRef<number | undefined>(undefined);
  const flush = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; const updates = pendingUpdates.current.splice(0); if (updates.length) setMessages((current) => updates.reduce((next, update) => update(next), current)); }, []);
  const queue = useCallback((update: MessageUpdate) => { pendingUpdates.current.push(update); if (frame.current === undefined) frame.current = requestAnimationFrame(flush); }, [flush]);
  const discardPendingUpdates = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; pendingUpdates.current.length = 0; }, []);
  useEffect(() => discardPendingUpdates, [discardPendingUpdates]);
  useEffect(() => { liveRevision.current += 1; activeAssistantId.current = undefined; discardPendingUpdates(); }, [discardPendingUpdates, transport]);

  const refresh = useCallback(async () => {
    const revision = liveRevision.current;
    const [nextState, history, modelResponse, thinkingResponse, commandResponse, stats] = await Promise.all([
      transport.command<AgentState>({ type: "get_state" }), transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }), transport.command<{ models: Model[] }>({ type: "get_available_models" }), transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }), transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" }), transport.command<{ contextUsage?: AgentState["contextUsage"] }>({ type: "get_session_stats" })
    ]);
    if (liveRevision.current === revision) { discardPendingUpdates(); setState({ ...nextState, contextUsage: stats.contextUsage }); setMessages(branchMessages(history.entries, history.leafId)); setModels(modelResponse.models); setThinkingLevels(thinkingResponse.levels); setCommands(commandResponse.commands.filter((command) => command.sourceInfo?.source !== "inline" && command.name !== "pi-orchestration-next")); }
    return nextState;
  }, [discardPendingUpdates, transport]);

  const handleEvent = useCallback((event: RpcEvent) => {
    if (["agent_start", "agent_end", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) liveRevision.current += 1;
    if (event.type === "agent_start") setState((current) => ({ ...current, isStreaming: true }));
    if (event.type === "agent_end" || event.type === "agent_settled") setState((current) => ({ ...current, isStreaming: false, activity: undefined }));
    if (event.type === "message_start" || event.type === "message_end") {
      if (event.type === "message_end") flush();
      let message = normalizeMessage(event.message as Record<string, unknown>);
      if (message.role === "assistant" && event.type === "message_start") { message = { ...message, streaming: true }; activeAssistantId.current = message.id; }
      if (message.role === "assistant" && event.type === "message_end") { message = { ...message, ...(activeAssistantId.current ? { id: activeAssistantId.current } : {}), completedAt: Date.now(), streaming: false }; activeAssistantId.current = undefined; }
      setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]);
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent) queue((current) => { let index = -1; for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) { const message = current[candidate]; if (message.role === "assistant" && (message.id === activeAssistantId.current || message.streaming)) { index = candidate; break; } } if (index < 0) return current; const next = [...current]; next[index] = applyAssistantMessageEvent(next[index], event.assistantMessageEvent); return next; });
      else if (event.message) { const message = { ...normalizeMessage(event.message as Record<string, unknown>), streaming: true }; queue((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]); }
    }
    if (event.type === "tool_execution_start") { const target = event.toolName === "call_agent" && event.args && typeof event.args === "object" ? String((event.args as { target?: unknown }).target ?? "") : ""; const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: target ? `${target} called` : String(event.toolName), toolStatus: "running", content: JSON.stringify(event.args ?? {}, null, 2), timestamp: Date.now() }; setMessages((current) => [...current.filter((item) => item.id !== message.id), message]); }
    if (event.type === "tool_execution_update") queue((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.partialResult), toolStatus: "running" } : item));
    if (event.type === "tool_execution_end") { flush(); setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.result), toolStatus: event.isError ? "error" : "done" } : item)); }
    if (event.type === "queue_update") setState((current) => ({ ...current, pendingMessageCount: [...((event.steering as unknown[]) ?? []), ...((event.followUp as unknown[]) ?? [])].length }));
    if (event.type === "compaction_start") setState((current) => ({ ...current, activity: "Compacting context…" }));
    if (event.type === "compaction_end") setState((current) => ({ ...current, activity: undefined, contextUsage: current.contextUsage ? { ...current.contextUsage, tokens: null, percent: null } : undefined }));
    if (event.type === "auto_retry_start") setState((current) => ({ ...current, activity: `Retrying · attempt ${event.attempt}` }));
    if (event.type === "thinking_level_changed" && typeof event.level === "string") setState((current) => ({ ...current, thinkingLevel: event.level as string }));
  }, [flush, queue]);

  return { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh, handleEvent, discardPendingUpdates };
}
