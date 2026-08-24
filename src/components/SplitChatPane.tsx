import { X } from "lucide-react";
import type { AgentState, ChatMessage, SessionSummary } from "../types";
import { ChatView } from "./ChatView";
import { IconButton } from "./IconButton";

interface Props { session: SessionSummary; messages?: ChatMessage[]; error?: string; onClose: () => void; }

const noop = () => undefined;

export function SplitChatPane({ session, messages, error, onClose }: Props) {
  const state: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 };
  return <section className="split-chat" aria-label={`Split conversation: ${session.name}`}>
    <header><strong>{session.name}</strong><IconButton label="Close split pane" onClick={onClose}><X size={15} /></IconButton></header>
    {error ? <div className="split-pane-status error">{error}</div> : messages ? <ChatView state={state} messages={messages} models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={[]} readOnly onSend={noop} onAbort={noop} onOpenTerminal={noop} onOpenProject={noop} onBranch={noop} onModel={noop} onThinking={noop} /> : <div className="split-pane-status">Loading conversation…</div>}
  </section>;
}
