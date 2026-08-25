import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentState, AppSettings, ChatMessage, ImageAttachment, Model, RpcEvent, SessionSummary, SlashCommand } from "../types";
import { createTransport } from "../lib/transport";
import { applyAssistantMessageEvent, branchMessages, normalizeMessage, type PiEntry } from "../lib/messages";
import { ChatView } from "./ChatView";
import { IconButton } from "./IconButton";

interface Props { session: SessionSummary; settings: AppSettings; draft: string; onDraftChange: (value: string) => void; onClose: () => void; forkFrom?: string; initialPrompt?: string; onComplete?: (answer: string) => void; onFailure?: (error: string) => void; }
const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });
const contentOf = (value: unknown): ChatMessage["content"] => (value as { content?: ChatMessage["content"] })?.content ?? "";

export function SplitChatPane({ session, settings, draft, onDraftChange, onClose, forkFrom, initialPrompt, onComplete, onFailure }: Props) {
  const transport = useMemo(createTransport, []); const [state, setState] = useState(() => initialState(session)); const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [commands, setCommands] = useState<SlashCommand[]>([]); const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]); const [error, setError] = useState<string>();
  const activeAssistantId = useRef<string | undefined>(undefined);
  const initialPromptStarted = useRef(false);
  const completionSent = useRef(false);
  const refresh = async () => {
    const [nextState, history, modelResponse, thinkingResponse, commandResponse] = await Promise.all([
      transport.command<AgentState>({ type: "get_state" }), transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }), transport.command<{ models: Model[] }>({ type: "get_available_models" }), transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }), transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" })
    ]);
    setState(nextState); setMessages(branchMessages(history.entries, history.leafId)); setModels(modelResponse.models); setThinkingLevels(thinkingResponse.levels); setCommands(commandResponse.commands.filter((command) => command.sourceInfo?.source !== "inline"));
  };
  useEffect(() => {
    let closing = false;
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      if (event.type === "agent_start") setState((current) => ({ ...current, isStreaming: true }));
      if (event.type === "agent_end" || event.type === "agent_settled") setState((current) => ({ ...current, isStreaming: false, activity: undefined }));
      if (event.type === "agent_settled" && initialPromptStarted.current && !completionSent.current) {
        completionSent.current = true;
        void transport.command<{ text: string | null }>({ type: "get_last_assistant_text" }).then(({ text }) => {
          if (text?.trim()) onComplete?.(text.trim());
          else onFailure?.("The /btw conversation finished without an answer");
        }).catch((reason) => onFailure?.(reason instanceof Error ? reason.message : String(reason)));
      }
      if (event.type === "message_start" || event.type === "message_end") {
        let message = normalizeMessage(event.message as Record<string, unknown>);
        if (message.role === "assistant" && event.type === "message_start") { message = { ...message, streaming: true }; activeAssistantId.current = message.id; }
        if (message.role === "assistant" && event.type === "message_end") { const assistantId = activeAssistantId.current; message = { ...message, ...(assistantId ? { id: assistantId } : {}), streaming: false }; activeAssistantId.current = undefined; }
        setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]);
        if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      }
      if (event.type === "message_update") setMessages((current) => {
        if (event.assistantMessageEvent) { let index = -1; for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) { const message = current[candidate]; if (message.role === "assistant" && (message.id === activeAssistantId.current || message.streaming)) { index = candidate; break; } } if (index < 0) return current; const next = [...current]; next[index] = applyAssistantMessageEvent(next[index], event.assistantMessageEvent); return next; }
        if (!event.message) return current; const message = { ...normalizeMessage(event.message as Record<string, unknown>), streaming: true }; return current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message];
      });
      if (event.type === "tool_execution_start") { const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: String(event.toolName), toolStatus: "running", content: JSON.stringify(event.args ?? {}, null, 2), timestamp: Date.now() }; setMessages((current) => [...current.filter((item) => item.id !== message.id), message]); }
      if (event.type === "tool_execution_update") setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: contentOf(event.partialResult), toolStatus: "running" } : item));
      if (event.type === "tool_execution_end") setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: contentOf(event.result), toolStatus: event.isError ? "error" : "done" } : item));
      if (event.type === "queue_update") setState((current) => ({ ...current, pendingMessageCount: [...((event.steering as unknown[]) ?? []), ...((event.followUp as unknown[]) ?? [])].length }));
      if (event.type === "disconnected" && !closing) setError("Pi disconnected before responding");
    });
    transport.connect(session.cwd, forkFrom ? undefined : session.path, session.hostId, forkFrom).then(() => refresh()).then(() => Promise.all([
      transport.command({ type: "set_auto_compaction", enabled: settings.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: settings.autoRetry }), transport.command({ type: "set_steering_mode", mode: settings.steeringMode }), transport.command({ type: "set_follow_up_mode", mode: settings.followUpMode })
    ])).then(() => {
      if (!initialPrompt || closing) return;
      initialPromptStarted.current = true;
      return transport.command({ type: "prompt", message: initialPrompt });
    }).catch((reason) => { if (!closing) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); onFailure?.(message); } });
    return () => { closing = true; unsubscribe(); void transport.disconnect(); };
  }, [transport, session.id, forkFrom, initialPrompt]);
  const send = (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => transport.command({ type: behavior === "steer" ? "steer" : behavior === "followUp" ? "follow_up" : "prompt", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  const branch = async (message: ChatMessage) => { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (user?.entryId) { await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); } };
  return <section className="split-chat" aria-label={`Split conversation: ${session.name}`}>
    <header><strong>{session.name}</strong><IconButton label="Close split pane" onClick={onClose}><X size={15} /></IconButton></header>
    {error ? <div className="split-pane-status error">{error}</div> : <ChatView state={state} messages={messages} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={[]} statuses={[]} projectCwd={session.cwd} draft={draft} onDraftChange={onDraftChange} onSend={send} onAbort={() => void transport.command({ type: "abort" })} onOpenProject={() => undefined} onBranch={branch} onModel={(model) => void transport.command({ type: "set_model", provider: model.provider, modelId: model.id }).then(() => setState((current) => ({ ...current, model })))} onThinking={(level) => void transport.command({ type: "set_thinking_level", level }).then(() => setState((current) => ({ ...current, thinkingLevel: level })))} />}
  </section>;
}
