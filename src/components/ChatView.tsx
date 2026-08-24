import { useEffect, useRef } from "react";
import type { AgentState, ChatMessage, ImageAttachment, Model, SlashCommand } from "../types";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { textOf, thinkingOf } from "../lib/content";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";

interface Props { state: AgentState; messages: ChatMessage[]; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: string[]; draft?: string; onDraftChange?: (value: string) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void; onAbort: () => void; onOpenTerminal: () => void; onBranch: (message: ChatMessage) => void; onModel: (model: Model) => void; onThinking: (level: string) => void; }

export function ChatView(props: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const turns = groupTurns(props.messages);
  const abortedTurn = !props.state.isStreaming ? findReplaceableAbortedTurn(props.messages) : undefined;
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: props.state.isStreaming ? "smooth" : "auto" }); }, [props.messages, props.state.isStreaming]);
  return <main className="chat-shell">
    <div className="messages" aria-live="polite"><div className="conversation">
      {!props.messages.length && <div className="empty-chat"><span>π</span></div>}
      {turns.map((turn, index) => <ConversationTurn key={turn[0]?.id || index} messages={turn} active={props.state.isStreaming && index === turns.length - 1} retryable={!props.state.isStreaming && index === turns.length - 1} onRetry={props.onSend} onBranch={props.onBranch} />)}<div ref={bottom} />
    </div></div>
    <div className="composer-stack">{props.widgets.length > 0 && <div className="extension-widget">{props.widgets.map((line, index) => <div key={index}>{line}</div>)}</div>} {props.statuses.length > 0 && <div className="extension-status">{props.statuses.join(" · ")}</div>}<Composer streaming={props.state.isStreaming} queued={props.state.pendingMessageCount} commands={props.commands} models={props.models} model={props.state.model} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} draft={props.draft} onDraftChange={props.onDraftChange} restoredDraft={abortedTurn ? { id: `${abortedTurn.assistant.timestamp ?? abortedTurn.assistant.id}:${abortedTurn.prompt}`, value: abortedTurn.prompt } : undefined} onSend={props.onSend} onAbort={props.onAbort} onOpenTerminal={props.onOpenTerminal} onModel={props.onModel} onThinking={props.onThinking} /></div>
  </main>;
}

function groupTurns(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[][]>((turns, message) => {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
    return turns;
  }, []);
}

function compactCompletedTools(messages: ChatMessage[]) {
  return messages.reduce<Array<{ message: ChatMessage; count: number }>>((runs, message) => {
    const hasToolCall = Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall");
    if (message.role === "assistant" && textOf(message.content).trim().length === 0 && thinkingOf(message.content).trim().length === 0 && (hasToolCall || (!message.streaming && !message.stopReason))) return runs;
    const previous = runs.at(-1);
    const status = message.toolStatus ?? "done";
    if (message.role === "tool" && status === "done" && previous?.message.role === "tool" && (previous.message.toolStatus ?? "done") === "done" && (previous.message.toolName || "tool") === (message.toolName || "tool")) {
      const outputs = [textOf(previous.message.content), textOf(message.content)].filter(Boolean);
      previous.message = { ...previous.message, content: outputs.join("\n\n") };
      previous.count += 1;
    } else runs.push({ message, count: 1 });
    return runs;
  }, []);
}

function renderMessages(messages: ChatMessage[], expanded: boolean, onBranch: Props["onBranch"]) {
  return compactCompletedTools(messages).map(({ message, count }) => <Message key={message.id} message={message} toolCount={count} expanded={expanded} onBranch={onBranch} />);
}

function ConversationTurn({ messages, active, retryable, onRetry, onBranch }: { messages: ChatMessage[]; active: boolean; retryable: boolean; onRetry: Props["onSend"]; onBranch: Props["onBranch"] }) {
  if (active) return <>{renderMessages(messages, true, onBranch)}</>;

  let finalIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && (textOf(message.content).trim().length > 0 || message.stopReason === "aborted" || message.stopReason === "error")) { finalIndex = index; break; }
  }
  const finalThinking = finalIndex >= 0 ? thinkingOf(messages[finalIndex].content) : "";
  const intermediate = messages.flatMap((message, index) => {
    if (message.role === "user") return [];
    if (index !== finalIndex) return [message];
    return finalThinking ? [{ ...message, id: `${message.id}:reasoning`, content: [{ type: "thinking" as const, thinking: finalThinking }], stopReason: undefined, errorMessage: undefined }] : [];
  });
  const userMessages = messages.filter((message) => message.role === "user");
  const finalMessage = finalIndex >= 0 ? { ...messages[finalIndex], content: textOf(messages[finalIndex].content) } : undefined;
  const retryPrompt = retryable && finalMessage?.stopReason === "aborted" ? [...userMessages].reverse().map((message) => textOf(message.content).trim()).find(Boolean) : undefined;

  return <section className="conversation-turn">
    {userMessages.map((message) => <Message key={message.id} message={message} onBranch={onBranch} />)}
    {intermediate.length > 0 && <details className="work-group"><summary>Work · {intermediate.length} {intermediate.length === 1 ? "step" : "steps"}</summary><div className="work-group-content">{renderMessages(intermediate, true, onBranch)}</div></details>}
    {finalMessage && <Message message={finalMessage} onBranch={onBranch} onRetry={retryPrompt ? () => { window.dispatchEvent(new CustomEvent("pi:set-editor-text", { detail: "" })); onRetry(retryPrompt); } : undefined} />}
  </section>;
}
