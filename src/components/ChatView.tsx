import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { FolderGit2 } from "lucide-react";
import type { AgentProfile, AgentState, ChatMessage, ComposerUpload, GitDiffSnapshots, ImageAttachment, Model, PromptDictionary, SequenceProfile, SlashCommand } from "../types";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { PromptContextBar } from "./PromptContextBar";
import { textOf, thinkingOf } from "../lib/content";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";
import { cacheHitStats } from "../lib/messages";
import { parseSequencePrompt } from "../lib/sequence";

interface Props { state: AgentState; messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; debug?: boolean; agents?: AgentProfile[]; sequences?: SequenceProfile[]; activeAgent?: string; dictionaries?: PromptDictionary[]; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: string[]; projectCwd?: string; readOnly?: boolean; controlsDisabled?: boolean; draft?: string; onDraftChange?: (value: string) => void; focusRequest?: number; onActivate?: () => void; uploads?: ComposerUpload[]; onUploadsChange?: (uploads: SetStateAction<ComposerUpload[]>) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | boolean | Promise<void | boolean>; onAbort: () => void | Promise<void>; onPause: () => void | Promise<void>; onResume: () => void | Promise<void>; onOpenTerminal?: () => void; onOpenProject: () => void; onBranch: (message: ChatMessage) => void; onCreateWorktree?: (message: ChatMessage) => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onThinking: (level: string) => void; }

export function ChatView(props: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | undefined>(undefined);
  const shell = useRef<HTMLElement>(null);
  const composerStack = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => groupTurns(props.messages), [props.messages]);
  const sessionUsage = useMemo(() => props.messages.reduce((total, message) => ({ input: total.input + (message.usage?.input ?? 0), cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0) }), { input: 0, cacheRead: 0 }), [props.messages]);
  const sessionCache = cacheHitStats(sessionUsage);
  const actions = useRef({ onSend: props.onSend, onBranch: props.onBranch, onCreateWorktree: props.onCreateWorktree });
  actions.current = { onSend: props.onSend, onBranch: props.onBranch, onCreateWorktree: props.onCreateWorktree };
  const onRetry = useCallback<Props["onSend"]>((...args) => actions.current.onSend(...args), []);
  const onBranch = useCallback<Props["onBranch"]>((message) => actions.current.onBranch(message), []);
  const onCreateWorktree = useCallback<NonNullable<Props["onCreateWorktree"]>>((message) => actions.current.onCreateWorktree?.(message), []);
  const projectName = props.projectCwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const retryable = !props.state.isStreaming && !props.state.isPaused && !props.state.isPausing;
  const abortedTurn = retryable ? findReplaceableAbortedTurn(props.messages) : undefined;
  const scrollToLatest = useCallback(() => {
    const element = messagesRef.current;
    if (!element || !followLatest.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  }, []);
  useLayoutEffect(scrollToLatest, [scrollToLatest, props.messages, props.gitDiffs, props.state.isStreaming]);
  useEffect(() => {
    const composer = composerStack.current;
    const chatShell = shell.current;
    if (!composer || !chatShell) return;
    const updateHeight = () => { chatShell.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`); scrollToLatest(); };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [props.readOnly, scrollToLatest]);
  return <main ref={shell} className="chat-shell" onFocusCapture={props.onActivate} onPointerDownCapture={props.onActivate}>
    <div ref={messagesRef} className="messages" aria-live="polite"
      onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) followLatest.current = false; }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => { const y = event.touches[0]?.clientY; if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) followLatest.current = false; touchY.current = y; }}
      onKeyDownCapture={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) followLatest.current = false; }}
      onScroll={(event) => {
        const element = event.currentTarget;
        // Our own scroll writes update lastScrollTop before their scroll event.
        // Only downward movement all the way to the bottom resumes following.
        if (element.scrollTop < lastScrollTop.current) followLatest.current = false;
        else if (element.scrollTop > lastScrollTop.current) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        lastScrollTop.current = element.scrollTop;
      }}><div className="conversation">
      {!props.messages.length && <div className="empty-chat"><span>π</span></div>}
      {turns.map((turn, index) => <ConversationTurn key={`${turn[0]?.timestamp ?? turn[0]?.id ?? "turn"}:${index}`} messages={turn} gitDiffs={props.gitDiffs} debug={props.debug ?? false} active={props.state.isStreaming && index === turns.length - 1} retryable={retryable && index === turns.length - 1} paused={Boolean(props.state.isPaused || props.state.isPausing) && index === turns.length - 1} onRetry={onRetry} onBranch={onBranch} onCreateWorktree={props.onCreateWorktree ? onCreateWorktree : undefined} />)}<div className="scroll-anchor" />
    </div></div>
    {!props.readOnly && <div ref={composerStack} className="composer-stack">{props.widgets.length > 0 && <div className="extension-widget">{props.widgets.map((line, index) => <div key={index}>{line}</div>)}</div>} {props.statuses.length > 0 && <div className="extension-status">{props.statuses.join(" · ")}</div>}{props.state.activity && <div className="runtime-activity" role="status">{props.state.activity}</div>}{!props.messages.length && props.state.messageCount === 0 && <div className="new-chat-project"><button type="button" className={projectName ? "selected" : undefined} aria-label={projectName ? `Selected project: ${projectName}` : "Choose project"} title={props.projectCwd} onClick={props.onOpenProject}><FolderGit2 size={14} />{projectName ?? "Choose project"}</button></div>}<Composer streaming={props.state.isStreaming} paused={props.state.isPaused} pausing={props.state.isPausing} queued={props.state.pendingMessageCount} commands={props.commands} agents={props.agents ?? []} sequences={props.sequences ?? []} activeAgent={props.activeAgent} dictionaries={props.dictionaries} models={props.models} model={props.state.model} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug ? sessionCache : undefined} contextUsage={props.state.contextUsage} controlsDisabled={props.controlsDisabled} draft={props.draft} onDraftChange={props.onDraftChange} focusRequest={props.focusRequest} uploads={props.uploads} onUploadsChange={props.onUploadsChange} restoredDraft={abortedTurn ? { id: `${abortedTurn.assistant.timestamp ?? abortedTurn.assistant.id}:${abortedTurn.prompt}`, value: abortedTurn.prompt } : undefined} onSend={props.onSend} onAbort={props.onAbort} onPause={props.onPause} onResume={props.onResume} onOpenTerminal={props.onOpenTerminal} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onThinking={props.onThinking} /></div>}
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

function renderMessages(messages: ChatMessage[], expanded: boolean, compact = true, debug = false, paused = false) {
  return compactCompletedTools(messages, compact).map(({ message, count }) => <Message key={message.id} message={message} toolCount={count} expanded={expanded} debug={debug} paused={paused} />);
}

type ConversationTurnProps = { messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; debug: boolean; active: boolean; retryable: boolean; paused: boolean; onRetry: Props["onSend"]; onBranch: Props["onBranch"]; onCreateWorktree?: Props["onCreateWorktree"] };

function ConversationTurnView({ messages, gitDiffs, debug, active, retryable, paused, onRetry, onBranch, onCreateWorktree }: ConversationTurnProps) {
  const [retryError, setRetryError] = useState<string>();
  const [retrying, setRetrying] = useState(false); const retryingRef = useRef(false);
  const userIndex = messages.findIndex((message) => message.role === "user");
  const parsed = userIndex >= 0 && (!messages[userIndex].entryId || messages[userIndex].sequenceMarkerAuthorized) ? parseSequencePrompt(textOf(messages[userIndex].content)) : { text: userIndex >= 0 ? textOf(messages[userIndex].content) : "" };
  if (parsed.step && !parsed.step.visible) return null;
  const shown = parsed.step ? messages.map((message, index) => index === userIndex ? { ...message, content: parsed.text } : message) : messages;
  const promptContext = userIndex >= 0 ? shown[userIndex].promptContext : undefined;

  let finalIndex = -1;
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const message = shown[index];
    if (message.role === "assistant" && (textOf(message.content).trim().length > 0 || message.stopReason === "aborted" || message.stopReason === "error")) { finalIndex = index; break; }
  }
  const finalThinking = finalIndex >= 0 ? thinkingOf(shown[finalIndex].content) : "";
  const intermediate = shown.flatMap((message, index) => {
    if (message.role === "user" || message.role === "system") return [];
    if (index !== finalIndex) return [message];
    if (!finalThinking) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;
    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking" as const, thinking: finalThinking }], stopReason: undefined, errorMessage: undefined }];
  });
  const userMessages = !active && !paused && parsed.step?.step ? [] : shown.filter((message) => message.role === "user");
  const finalMessage = finalIndex >= 0 ? { ...shown[finalIndex], content: textOf(shown[finalIndex].content) } : undefined;
  const worktreeResponse = finalMessage && !["toolUse", "aborted", "error"].includes(finalMessage.stopReason ?? "") ? onCreateWorktree : undefined;
  const gitDiff = finalMessage ? gitDiffs?.[finalMessage.id] : undefined;
  const workedFor = formatWorkedFor(userIndex >= 0 ? shown[userIndex].timestamp : shown[0]?.timestamp, finalMessage?.completedAt ?? finalMessage?.timestamp);
  const retryPrompt = retryable ? findReplaceableAbortedTurn(shown)?.prompt : undefined;

  return <section className="conversation-turn">
    {parsed.step && parsed.step.step > 0 && <div className="sequence-step-label">{parsed.step.sequence} · {parsed.step.agent}</div>}
    {userMessages.map((message) => <Message key={message.id} message={message} debug={debug} />)}
    {debug && promptContext && <PromptContextBar context={promptContext} />}
    {active || paused ? renderMessages(shown.filter((message) => message.role !== "user"), true, false, debug, paused) : <>
    {intermediate.length > 0 && <details className="work-group"><summary>{workedFor ? `Worked for ${workedFor}` : "Work"}</summary><div className="work-group-content">{renderMessages(intermediate, true, true, false, paused)}</div></details>}
    {finalMessage && <Message message={finalMessage} diff={gitDiff} debug={debug} paused={paused} onBranch={onBranch} onCreateWorktree={worktreeResponse} retrying={retrying} onRetry={retryPrompt ? () => { if (retryingRef.current) return; retryingRef.current = true; setRetrying(true); setRetryError(undefined); void Promise.resolve(onRetry(retryPrompt)).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => { retryingRef.current = false; setRetrying(false); }); } : undefined} />}
    {retryError && <div className="message-failure retry-error" role="alert">Retry failed: {retryError}</div>}
    {renderMessages(shown.filter((message) => message.role === "system"), false)}
    </>}
  </section>;
}

const ConversationTurn = memo(ConversationTurnView, (previous, next) => previous.active === next.active
  && previous.retryable === next.retryable && previous.paused === next.paused && previous.debug === next.debug && previous.gitDiffs === next.gitDiffs
  && previous.onRetry === next.onRetry && previous.onBranch === next.onBranch
  && previous.onCreateWorktree === next.onCreateWorktree && previous.messages.length === next.messages.length
  && previous.messages.every((message, index) => message === next.messages[index]));
