import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentState, AppSettings, ChatMessage, ImageAttachment, RpcEvent, SessionSummary } from "../types";
import { NativeTransport } from "../lib/nativeTransport";
import { useChatSession } from "../lib/useChatSession";
import { ChatView } from "./ChatView";
import { IconButton } from "./IconButton";

interface Props { session: SessionSummary; settings: AppSettings; draft: string; onDraftChange: (value: string) => void; onClose: () => void; forkFrom?: string; initialPrompt?: string; onComplete?: (answer: string) => void; onFailure?: (error: string) => void; }
const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane({ session, settings, draft, onDraftChange, onClose, forkFrom, initialPrompt, onComplete, onFailure }: Props) {
  const transport = useMemo(() => new NativeTransport(), []); const runtime = useChatSession(transport, initialState(session));
  const { state, setState, messages, models, commands, thinkingLevels, refresh, handleEvent } = runtime; const [error, setError] = useState<string>();
  const initialPromptStarted = useRef(false);
  const completionSent = useRef(false);
  useEffect(() => {
    let closing = false;
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      if (event.type === "agent_settled" && initialPromptStarted.current && !completionSent.current) {
        completionSent.current = true;
        void transport.command<{ text: string | null }>({ type: "get_last_assistant_text" }).then(({ text }) => {
          if (text?.trim()) onComplete?.(text.trim());
          else onFailure?.("The /btw conversation finished without an answer");
        }).catch((reason) => onFailure?.(reason instanceof Error ? reason.message : String(reason)));
      }
      if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      if (event.type === "disconnected" && !closing) setError("Pi disconnected before responding");
    });
    transport.connect(session.cwd, forkFrom ? undefined : session.path, session.hostId, forkFrom).then(() => refresh()).then(() => Promise.all([
      transport.command({ type: "set_auto_compaction", enabled: settings.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: settings.autoRetry })
    ])).then(() => {
      if (!initialPrompt || closing) return;
      initialPromptStarted.current = true;
      return transport.command({ type: "prompt", message: initialPrompt });
    }).catch((reason) => { if (!closing) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); onFailure?.(message); } });
    return () => { closing = true; unsubscribe(); void transport.disconnect(); };
  }, [transport, session.id, forkFrom, initialPrompt, handleEvent, refresh]);
  const send = (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => transport.command({ type: behavior === "steer" ? "steer" : behavior === "followUp" ? "follow_up" : "prompt", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  const branch = async (message: ChatMessage) => { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (user?.entryId) { await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); } };
  return <section className="split-chat" aria-label={`Split conversation: ${session.name}`}>
    <header><strong>{session.name}</strong><IconButton label="Close split pane" onClick={onClose}><X size={15} /></IconButton></header>
    {error ? <div className="split-pane-status error">{error}</div> : <ChatView state={state} messages={messages} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={[]} statuses={[]} projectCwd={session.cwd} draft={draft} onDraftChange={onDraftChange} onSend={send} onAbort={() => void transport.command({ type: "abort" })} onOpenProject={() => undefined} onBranch={branch} onModel={(model) => void transport.command({ type: "set_model", provider: model.provider, modelId: model.id }).then(() => setState((current) => ({ ...current, model })))} onThinking={(level) => void transport.command({ type: "set_thinking_level", level }).then(() => setState((current) => ({ ...current, thinkingLevel: level })))} />}
  </section>;
}
