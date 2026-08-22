import { useEffect, useRef, useState } from "react";
import { Archive, CopyPlus, FileDown, GitFork, MoreHorizontal, Pencil } from "lucide-react";
import type { AgentState, ChatMessage, ImageAttachment, Model, SlashCommand } from "../types";
import { IconButton } from "./IconButton";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { textOf } from "../lib/content";

interface Props { state: AgentState; messages: ChatMessage[]; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: string[]; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void; onAbort: () => void; onOpenTerminal: () => void; onBranch: (message: ChatMessage) => void; onRetry: (message: ChatMessage) => void; onModel: (model: Model) => void; onThinking: (level: string) => void; onSessionAction: (action: "rename" | "clone" | "compact" | "export" | "inspect") => void; }

export function ChatView(props: Props) {
  const bottom = useRef<HTMLDivElement>(null); const [menuOpen, setMenuOpen] = useState(false);
  const turns = groupTurns(props.messages);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: props.state.isStreaming ? "smooth" : "auto" }); }, [props.messages, props.state.isStreaming]);
  return <main className="chat-shell">
    <header className="chat-header">
      <div className="chat-title"><span className="status-dot" /><div><strong>{props.state.sessionName || "Untitled session"}</strong><small>{props.state.activity || (props.state.isStreaming ? "Pi is working" : "Ready")}</small></div></div>
      <div className="header-controls">
        <div className="menu-anchor"><IconButton label="Conversation menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={19} /></IconButton>{menuOpen && <div className="conversation-menu">{[
          ["rename", Pencil, "Rename conversation"], ["clone", CopyPlus, "Clone conversation"], ["compact", Archive, "Compact context"], ["export", FileDown, "Export as HTML"], ["inspect", GitFork, "Tree & session stats"]
        ].map(([action, Icon, label]) => <button key={String(action)} onClick={() => { setMenuOpen(false); props.onSessionAction(action as Parameters<Props["onSessionAction"]>[0]); }}><Icon size={14} />{String(label)}</button>)}</div>}</div>
      </div>
    </header>
    <div className="messages" aria-live="polite"><div className="conversation">
      {!props.messages.length && <div className="empty-chat"><span>π</span></div>}
      {turns.map((turn, index) => <ConversationTurn key={turn[0]?.id || index} messages={turn} active={props.state.isStreaming && index === turns.length - 1} onBranch={props.onBranch} onRetry={props.onRetry} />)}<div ref={bottom} />
    </div></div>
    <div className="composer-stack">{props.widgets.length > 0 && <div className="extension-widget">{props.widgets.map((line, index) => <div key={index}>{line}</div>)}</div>} {props.statuses.length > 0 && <div className="extension-status">{props.statuses.join(" · ")}</div>}<Composer streaming={props.state.isStreaming} queued={props.state.pendingMessageCount} commands={props.commands} models={props.models} model={props.state.model} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} onSend={props.onSend} onAbort={props.onAbort} onOpenTerminal={props.onOpenTerminal} onModel={props.onModel} onThinking={props.onThinking} /></div>
  </main>;
}

function groupTurns(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[][]>((turns, message) => {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
    return turns;
  }, []);
}

function ConversationTurn({ messages, active, onBranch, onRetry }: { messages: ChatMessage[]; active: boolean; onBranch: Props["onBranch"]; onRetry: Props["onRetry"] }) {
  if (active) return <>{messages.map((message) => <Message key={message.id} message={message} expanded onBranch={onBranch} onRetry={onRetry} />)}</>;

  let finalIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && textOf(messages[index].content).trim().length > 0) { finalIndex = index; break; }
  }
  const intermediate = messages.filter((message, index) => message.role !== "user" && index !== finalIndex);
  const userMessages = messages.filter((message) => message.role === "user");
  const finalMessage = finalIndex >= 0 ? messages[finalIndex] : undefined;

  return <section className="conversation-turn">
    {userMessages.map((message) => <Message key={message.id} message={message} onBranch={onBranch} onRetry={onRetry} />)}
    {intermediate.length > 0 && <details className="work-group"><summary>Work · {intermediate.length} {intermediate.length === 1 ? "step" : "steps"}</summary><div className="work-group-content">{intermediate.map((message) => <Message key={message.id} message={message} expanded onBranch={onBranch} onRetry={onRetry} />)}</div></details>}
    {finalMessage && <Message message={finalMessage} onBranch={onBranch} onRetry={onRetry} />}
  </section>;
}
