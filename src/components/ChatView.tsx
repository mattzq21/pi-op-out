import { useEffect, useRef } from "react";
import { FolderGit2 } from "lucide-react";
import type { AgentProfile, AgentState, ChatMessage, GitDiffSnapshots, ImageAttachment, Model, PromptContextInfo, PromptDictionary, SequenceProfile, SlashCommand } from "../types";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { textOf, thinkingOf } from "../lib/content";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";
import { cacheHitStats } from "../lib/messages";
import { parseSequencePrompt } from "../lib/sequence";

interface Props { state: AgentState; messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; promptContext?: PromptContextInfo; debug?: boolean; agents?: AgentProfile[]; sequences?: SequenceProfile[]; activeAgent?: string; dictionaries?: PromptDictionary[]; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: string[]; projectCwd?: string; readOnly?: boolean; draft?: string; onDraftChange?: (value: string) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | Promise<void>; onAbort: () => void; onOpenTerminal?: () => void; onOpenProject: () => void; onBranch: (message: ChatMessage) => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onThinking: (level: string) => void; }

export function ChatView(props: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLElement>(null);
  const composerStack = useRef<HTMLDivElement>(null);
  const turns = groupTurns(props.messages);
  const sessionUsage = props.messages.reduce((total, message) => ({ input: total.input + (message.usage?.input ?? 0), cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0) }), { input: 0, cacheRead: 0 });
  const sessionCache = cacheHitStats(sessionUsage);
  const projectName = props.projectCwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const abortedTurn = !props.state.isStreaming ? findReplaceableAbortedTurn(props.messages) : undefined;
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "auto" }); }, [props.messages, props.gitDiffs, props.state.isStreaming]);
  useEffect(() => {
    const composer = composerStack.current;
    const chatShell = shell.current;
    if (!composer || !chatShell) return;
    const updateHeight = () => chatShell.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [props.readOnly]);
  return <main ref={shell} className="chat-shell">
    <div className="messages" aria-live="polite"><div className="conversation">
      {!props.messages.length && <div className="empty-chat"><span>π</span></div>}
      {turns.map((turn, index) => <ConversationTurn key={turn[0]?.id || index} messages={turn} gitDiffs={props.gitDiffs} promptContext={props.promptContext} debug={props.debug ?? false} active={props.state.isStreaming && index === turns.length - 1} retryable={!props.state.isStreaming && index === turns.length - 1} onRetry={props.onSend} onBranch={props.onBranch} />)}<div ref={bottom} className="scroll-anchor" />
    </div></div>
    {!props.readOnly && <div ref={composerStack} className="composer-stack">{props.widgets.length > 0 && <div className="extension-widget">{props.widgets.map((line, index) => <div key={index}>{line}</div>)}</div>} {props.statuses.length > 0 && <div className="extension-status">{props.statuses.join(" · ")}</div>}{!props.messages.length && props.state.messageCount === 0 && <div className="new-chat-project"><button type="button" className={projectName ? "selected" : undefined} aria-label={projectName ? `Selected project: ${projectName}` : "Choose project"} title={props.projectCwd} onClick={props.onOpenProject}><FolderGit2 size={14} />{projectName ?? "Choose project"}</button></div>}<Composer streaming={props.state.isStreaming} queued={props.state.pendingMessageCount} commands={props.commands} agents={props.agents ?? []} sequences={props.sequences ?? []} activeAgent={props.activeAgent} dictionaries={props.dictionaries} models={props.models} model={props.state.model} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug ? sessionCache : undefined} contextUsage={props.state.contextUsage} draft={props.draft} onDraftChange={props.onDraftChange} restoredDraft={abortedTurn ? { id: `${abortedTurn.assistant.timestamp ?? abortedTurn.assistant.id}:${abortedTurn.prompt}`, value: abortedTurn.prompt } : undefined} onSend={props.onSend} onAbort={props.onAbort} onOpenTerminal={props.onOpenTerminal} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onThinking={props.onThinking} /></div>}
  </main>;
}

function groupTurns(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[][]>((turns, message) => {
    if (message.role === "user" || message.customType === "pi-desktop-btw" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
    return turns;
  }, []);
}

function formatWorkedFor(startedAt?: number, completedAt?: number) {
  if (startedAt === undefined || completedAt === undefined || completedAt < startedAt) return "";
  const totalSeconds = Math.max(1, Math.round((completedAt - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}min` : ""}`;
  if (minutes > 0) return `${minutes}min${seconds > 0 ? ` ${seconds}s` : ""}`;
  return `${seconds}s`;
}

function compactCompletedTools(messages: ChatMessage[], groupRepeated = true) {
  return messages.reduce<Array<{ message: ChatMessage; count: number }>>((runs, message) => {
    const hasToolCall = Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall");
    if (message.role === "assistant" && textOf(message.content).trim().length === 0 && thinkingOf(message.content).trim().length === 0 && (hasToolCall || (!message.streaming && !message.stopReason))) return runs;
    const previous = runs.at(-1);
    const status = message.toolStatus ?? "done";
    if (groupRepeated && message.role === "tool" && status === "done" && previous?.message.role === "tool" && (previous.message.toolStatus ?? "done") === "done" && (previous.message.toolName || "tool") === (message.toolName || "tool")) {
      const outputs = [textOf(previous.message.content), textOf(message.content)].filter(Boolean);
      previous.message = { ...previous.message, content: outputs.join("\n\n") };
      previous.count += 1;
    } else runs.push({ message, count: 1 });
    return runs;
  }, []);
}

function renderMessages(messages: ChatMessage[], expanded: boolean, onBranch: Props["onBranch"], compact = true, promptContext?: PromptContextInfo, debug = false) {
  return compactCompletedTools(messages, compact).map(({ message, count }) => <Message key={message.id} message={message.role === "assistant" && !message.promptContext && promptContext ? { ...message, promptContext } : message} toolCount={count} expanded={expanded} debug={debug} onBranch={onBranch} />);
}

function ConversationTurn({ messages, gitDiffs, promptContext, debug, active, retryable, onRetry, onBranch }: { messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; promptContext?: PromptContextInfo; debug: boolean; active: boolean; retryable: boolean; onRetry: Props["onSend"]; onBranch: Props["onBranch"] }) {
  const userIndex = messages.findIndex((message) => message.role === "user");
  const parsed = userIndex >= 0 ? parseSequencePrompt(textOf(messages[userIndex].content)) : { text: "" };
  if (parsed.step && !parsed.step.visible) return null;
  const shown = parsed.step ? messages.map((message, index) => index === userIndex ? { ...message, content: parsed.text } : message) : messages;
  if (active) return <>{parsed.step && parsed.step.step > 0 && <div className="sequence-step-label">{parsed.step.sequence} · {parsed.step.agent}</div>}{renderMessages(shown, true, onBranch, false, promptContext, debug)}</>;

  let finalIndex = -1;
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const message = shown[index];
    if (message.role === "assistant" && (textOf(message.content).trim().length > 0 || message.stopReason === "aborted" || message.stopReason === "error")) { finalIndex = index; break; }
  }
  const finalThinking = finalIndex >= 0 ? thinkingOf(shown[finalIndex].content) : "";
  const intermediate = shown.flatMap((message, index) => {
    if (message.role === "user") return [];
    if (index !== finalIndex) return [message];
    if (!finalThinking) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;
    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking" as const, thinking: finalThinking }], stopReason: undefined, errorMessage: undefined }];
  });
  const userMessages = parsed.step?.step ? [] : shown.filter((message) => message.role === "user");
  const finalContext = finalIndex >= 0 ? shown[finalIndex].promptContext ?? promptContext : undefined;
  const finalMessage = finalIndex >= 0 ? { ...shown[finalIndex], ...(!shown[finalIndex].promptContext && finalContext ? { promptContext: finalContext } : {}), content: textOf(shown[finalIndex].content) } : undefined;
  const gitDiff = finalMessage ? gitDiffs?.[finalMessage.id] : undefined;
  const workedFor = formatWorkedFor(userIndex >= 0 ? shown[userIndex].timestamp : shown[0]?.timestamp, finalMessage?.completedAt ?? finalMessage?.timestamp);
  const retryPrompt = retryable && finalMessage?.stopReason === "aborted" ? [...userMessages].reverse().map((message) => textOf(message.content).trim()).find(Boolean) : undefined;

  return <section className="conversation-turn">
    {parsed.step && parsed.step.step > 0 && <div className="sequence-step-label">{parsed.step.sequence} · {parsed.step.agent}</div>}
    {userMessages.map((message) => <Message key={message.id} message={message} debug={debug} onBranch={onBranch} />)}
    {intermediate.length > 0 && <details className="work-group"><summary>{workedFor ? `Worked for ${workedFor}` : "Work"}</summary><div className="work-group-content">{renderMessages(intermediate, true, onBranch)}</div></details>}
    {finalMessage && <Message message={finalMessage} diff={gitDiff} debug={debug} onBranch={onBranch} onRetry={retryPrompt ? () => { window.dispatchEvent(new CustomEvent("pi:set-editor-text", { detail: "" })); onRetry(retryPrompt); } : undefined} />}
  </section>;
}
