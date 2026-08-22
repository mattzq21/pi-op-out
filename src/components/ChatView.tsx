import { useEffect, useRef } from "react";
import type { AgentState, ChatMessage, ImageAttachment, Model, SlashCommand } from "../types";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { textOf } from "../lib/content";

interface Props { state: AgentState; messages: ChatMessage[]; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: string[]; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void; onAbort: () => void; onOpenTerminal: () => void; onBranch: (message: ChatMessage) => void; onModel: (model: Model) => void; onThinking: (level: string) => void; }

function compactTitle(title: string) { const characters = Array.from(title); return characters.length > 25 ? `${characters.slice(0, 25).join("")}…` : title; }

export function ChatView(props: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const turns = groupTurns(props.messages);
  const sessionTitle = props.state.sessionName || "Untitled session";
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: props.state.isStreaming ? "smooth" : "auto" }); }, [props.messages, props.state.isStreaming]);
  return <main className="chat-shell">
    <header className="chat-header">
      <div className="chat-title"><span className="status-dot" /><div><strong title={sessionTitle}>{compactTitle(sessionTitle)}</strong><small>{props.state.activity || (props.state.isStreaming ? "Pi is working" : "Ready")}</small></div></div>
    </header>
    <div className="messages" aria-live="polite"><div className="conversation">
      {!props.messages.length && <div className="empty-chat"><span>π</span></div>}
      {turns.map((turn, index) => <ConversationTurn key={turn[0]?.id || index} messages={turn} active={props.state.isStreaming && index === turns.length - 1} onBranch={props.onBranch} />)}<div ref={bottom} />
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

function ConversationTurn({ messages, active, onBranch }: { messages: ChatMessage[]; active: boolean; onBranch: Props["onBranch"] }) {
  if (active) return <>{messages.map((message) => <Message key={message.id} message={message} expanded onBranch={onBranch} />)}</>;

  let finalIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && textOf(messages[index].content).trim().length > 0) { finalIndex = index; break; }
  }
  const intermediate = messages.filter((message, index) => message.role !== "user" && index !== finalIndex);
  const userMessages = messages.filter((message) => message.role === "user");
  const finalMessage = finalIndex >= 0 ? messages[finalIndex] : undefined;

  return <section className="conversation-turn">
    {userMessages.map((message) => <Message key={message.id} message={message} onBranch={onBranch} />)}
    {intermediate.length > 0 && <details className="work-group"><summary>Work · {intermediate.length} {intermediate.length === 1 ? "step" : "steps"}</summary><div className="work-group-content">{intermediate.map((message) => <Message key={message.id} message={message} expanded onBranch={onBranch} />)}</div></details>}
    {finalMessage && <Message message={finalMessage} onBranch={onBranch} />}
  </section>;
}
