import { useVoiceMessages } from "../lib/useVoiceMessages";
import { VOICE_MESSAGE } from "../lib/voiceMessages";
import { VoiceControls } from "./VoiceControls";
import type { NativeTransport } from "../lib/nativeTransport";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ChevronRight, FolderGit2, LoaderCircle, X } from "lucide-react";
import type { AgentProfile, AgentState, ChatMessage, ComposerUpload, GitDiffSnapshots, ImageAttachment, Model, SlashCommand } from "../types";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { PromptContextBar } from "./PromptContextBar";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";
import { cacheHitStats } from "../lib/messages";
import { turnDiff } from "../lib/turnDiff";
import { DiffViewer } from "./DiffViewer";

interface Props { voiceTransport?: NativeTransport; state: AgentState; messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; debug?: boolean; agents?: AgentProfile[]; activeAgent?: string; agentLocked?: boolean; agentSaved?: boolean; agentUnavailable?: boolean; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: Record<string, string>; projectCwd?: string; readOnly?: boolean; controlsDisabled?: boolean; selectionBtw?: boolean; draft?: string; onDraftChange?: (value: string) => void; focusRequest?: number; onActivate?: () => void; uploads?: ComposerUpload[]; onUploadsChange?: (uploads: SetStateAction<ComposerUpload[]>) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | boolean | Promise<void | boolean>; onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>; onAbort: () => void | Promise<void>; onPause: () => void | Promise<void>; onResume: () => void | Promise<void>; onOpenTerminal?: () => void; onOpenProject: () => void; onClearProject?: () => void; onBranch: (message: ChatMessage) => void; onForkAndForget?: (message: ChatMessage) => void | Promise<void>; onCreateWorktree?: (message: ChatMessage) => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onToggleFastMode: () => void | Promise<void>; onThinking: (level: string) => void; }

type SelectionBtwTip = { text: string; left: number; top: number; below: boolean };

export function ChatView(props: Props) {
  const [ownsConversation, setOwnsConversation] = useState(() => props.voiceTransport?.ownsConversation() !== false);
  const [takingOwnership, setTakingOwnership] = useState(false);
  const [ownershipError, setOwnershipError] = useState<string>();
  useEffect(() => {
    setOwnsConversation(props.voiceTransport?.ownsConversation() !== false);
    setOwnershipError(undefined);
    const unsubscribe = props.voiceTransport?.subscribe((event) => {
      if (event.type === "ownership_lost") setOwnsConversation(false);
      if (event.type === "ownership_acquired") { setOwnsConversation(true); setOwnershipError(undefined); }
    });
    return () => { unsubscribe?.(); };
  }, [props.voiceTransport]);
  const takeOwnership = async () => {
    setTakingOwnership(true); setOwnershipError(undefined);
    try { await props.voiceTransport?.takeOwnership(); }
    catch (reason) { setOwnershipError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setTakingOwnership(false); }
  };
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | undefined>(undefined);
  const shell = useRef<HTMLElement>(null);
  const composerStack = useRef<HTMLDivElement>(null);
  const [selectionBtwTip, setSelectionBtwTip] = useState<SelectionBtwTip>();
  const [askingSelection, setAskingSelection] = useState(false);
  const [selectionBtwError, setSelectionBtwError] = useState(false);
  const messages = useVoiceMessages(props.messages, props.voiceTransport, props.state.sessionId);
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const sessionUsage = useMemo(() => props.messages.reduce((total, message) => ({ input: total.input + (message.usage?.input ?? 0), cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0), cacheWrite: total.cacheWrite + (message.usage?.cacheWrite ?? 0) }), { input: 0, cacheRead: 0, cacheWrite: 0 }), [props.messages]);
  const sessionCache = cacheHitStats(sessionUsage);
  const [submittedMessage, setSubmittedMessage] = useState<ChatMessage>();
  const send: Props["onSend"] = async (text, behavior, images = []) => {
    if (!ownsConversation || props.controlsDisabled) return false;
    const message: ChatMessage = { id: crypto.randomUUID(), role: "user", content: [{ type: "text", text }, ...images] };
    setSubmittedMessage(message);
    try { return await props.onSend(text, behavior, images); }
    finally { setSubmittedMessage((current) => current?.id === message.id ? undefined : current); }
  };
  const actions = useRef({ onSend: send, onBranch: props.onBranch, onForkAndForget: props.onForkAndForget, onCreateWorktree: props.onCreateWorktree });
  actions.current = { onSend: send, onBranch: props.onBranch, onForkAndForget: props.onForkAndForget, onCreateWorktree: props.onCreateWorktree };
  const retryDraft = useRef({ value: props.draft, change: props.onDraftChange, mounted: true });
  retryDraft.current.value = props.draft; retryDraft.current.change = props.onDraftChange;
  useEffect(() => { retryDraft.current.mounted = true; return () => { retryDraft.current.mounted = false; }; }, []);
  const onRetry = useCallback<Props["onSend"]>(async (...args) => {
    const submittedDraft = retryDraft.current.value; const change = retryDraft.current.change;
    const consumed = submittedDraft === args[0];
    if (consumed) { retryDraft.current.value = ""; change?.(""); }
    const restore = () => { if (consumed && retryDraft.current.mounted && !retryDraft.current.value) change?.(submittedDraft); };
    try { const result = await actions.current.onSend(...args); if (result === false) restore(); return result; }
    catch (reason) { restore(); throw reason; }
  }, []);
  const onBranch = useCallback<Props["onBranch"]>((message) => actions.current.onBranch(message), []);
  const onForkAndForget = useCallback<NonNullable<Props["onForkAndForget"]>>((message) => actions.current.onForkAndForget?.(message), []);
  const onCreateWorktree = useCallback<NonNullable<Props["onCreateWorktree"]>>((message) => actions.current.onCreateWorktree?.(message), []);
  const fastModeStatus = props.statuses["pi-desktop-fast-mode"];
  const mcpLoading = props.statuses["pi-desktop-mcp-loading"];
  const loadingServers = useMemo((): { id: string; name: string }[] => {
    if (!mcpLoading) return [];
    if (!mcpLoading.startsWith("json:")) return [{ id: "loading", name: mcpLoading.replace(/^Loading /, "") }];
    try {
      const value: unknown = JSON.parse(mcpLoading.slice(5));
      return Array.isArray(value) ? value.filter((server): server is { id: string; name: string } => server && typeof server.id === "string" && typeof server.name === "string") : [];
    } catch { return []; }
  }, [mcpLoading]);
  const activity = mcpLoading ? undefined : props.state.activity;
  const statuses = Object.entries(props.statuses).filter(([key]) => !["pi-desktop-hook-stats", "pi-desktop-fast-mode", "pi-desktop-mcp-loading"].includes(key)).map(([, text]) => text);
  const projectName = props.projectCwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const retryable = ownsConversation && !props.controlsDisabled && !props.state.isStreaming && !props.state.isPaused && !props.state.isPausing;
  const abortedTurn = retryable ? findReplaceableAbortedTurn(props.messages) : undefined;
  const scrollToLatest = useCallback(() => {
    const element = messagesRef.current;
    if (!element || !followLatest.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  }, []);
  useLayoutEffect(scrollToLatest, [scrollToLatest, messages, props.gitDiffs, props.state.isStreaming, mcpLoading, submittedMessage]);
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
  const selectionBtwEnabled = Boolean(ownsConversation && props.selectionBtw && !props.readOnly && !props.controlsDisabled && props.commands.some((command) => command.name === "btw"));
  useEffect(() => {
    if (!selectionBtwEnabled) { setSelectionBtwTip(undefined); return; }
    const updateTip = () => {
      const selection = window.getSelection();
      const messages = messagesRef.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !messages) { setSelectionBtwTip(undefined); return; }
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      const messageBody = ancestor?.closest(".message-body");
      if (!messageBody || !messages.contains(messageBody) || !messageBody.contains(range.startContainer) || !messageBody.contains(range.endContainer)) { setSelectionBtwTip(undefined); return; }
      const text = selection.toString().trim();
      const rect = Array.from(range.getClientRects()).filter((box) => box.width || box.height).at(-1);
      if (!text || !rect) { setSelectionBtwTip(undefined); return; }
      const below = rect.top < 48;
      setSelectionBtwError(false);
      setSelectionBtwTip({ text, left: Math.max(112, Math.min(rect.left + rect.width / 2, window.innerWidth - 112)), top: below ? rect.bottom + 8 : rect.top - 8, below });
    };
    const dismiss = () => setSelectionBtwTip(undefined);
    document.addEventListener("selectionchange", updateTip);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("selectionchange", updateTip);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [selectionBtwEnabled]);
  const askSelectionInBtw = async () => {
    if (!selectionBtwTip || askingSelection) return;
    setAskingSelection(true);
    try {
      await send(`/btw ${selectionBtwTip.text}`, props.state.isStreaming ? "followUp" : undefined);
      window.getSelection()?.removeAllRanges();
      setSelectionBtwTip(undefined);
    } catch { setSelectionBtwError(true); }
    finally { setAskingSelection(false); }
  };
  return <main ref={shell} className={`chat-shell${ownsConversation ? "" : " conversation-unowned"}`} onFocusCapture={props.onActivate} onPointerDownCapture={props.onActivate}>
    <div className="conversation-content">
    {(props.state.viewers ?? 0) > 1 && <div className="concurrent-view-status" role="status">Open in {props.state.viewers} views · Messages and controls are shared</div>}
    <div ref={messagesRef} className="messages" aria-live="polite"
      onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) followLatest.current = false; }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => { const y = event.touches[0]?.clientY; if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) followLatest.current = false; touchY.current = y; }}
      onKeyDownCapture={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) followLatest.current = false; }}
      onScroll={(event) => {
        setSelectionBtwTip(undefined);
        const element = event.currentTarget;
        // Our own scroll writes update lastScrollTop before their scroll event.
        // Only downward movement all the way to the bottom resumes following.
        if (element.scrollTop < lastScrollTop.current) followLatest.current = false;
        else if (element.scrollTop > lastScrollTop.current) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        lastScrollTop.current = element.scrollTop;
      }}><div className="conversation">
      {!messages.length && !mcpLoading && <div className="empty-chat"><span>πop</span></div>}
      {turns.map((turn, index) => <ConversationTurn key={`${turn[0]?.timestamp ?? turn[0]?.id ?? "turn"}:${index}`} messages={turn} gitDiffs={props.gitDiffs} cwd={props.projectCwd} debug={props.debug ?? false} active={props.state.isStreaming && index === turns.length - 1} retryable={retryable && index === turns.length - 1} paused={Boolean(props.state.isPaused || props.state.isPausing) && index === turns.length - 1} onRetry={onRetry} onBranch={onBranch} onForkAndForget={props.onForkAndForget ? onForkAndForget : undefined} onCreateWorktree={props.onCreateWorktree ? onCreateWorktree : undefined} />)}
      {mcpLoading && <section className="mcp-pending-turn" aria-label="Message waiting for MCP" aria-busy="true">
        {submittedMessage && <div className="mcp-pending-message"><Message message={submittedMessage} showActions={false} /></div>}
        <div className="mcp-loading-list" role="status">{props.debug ? loadingServers.map((server) => <div className="mcp-loading" key={server.id}><LoaderCircle className="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading {server.name}</span></div>) : <div className="mcp-loading"><LoaderCircle className="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading MCPs</span></div>}</div>
      </section>}
      <div className="scroll-anchor" />
    </div></div>
    {selectionBtwTip && <button type="button" className={`selection-btw-tip${selectionBtwTip.below ? " below" : ""}${selectionBtwError ? " error" : ""}`} style={{ left: selectionBtwTip.left, top: selectionBtwTip.top }} aria-label="Ask about selected text in a side chat with /btw" aria-live="polite" disabled={askingSelection} onPointerDown={(event) => event.preventDefault()} onClick={() => void askSelectionInBtw()}><span>{askingSelection ? "Opening side chat…" : selectionBtwError ? "Could not open side chat" : "Ask in side chat"}</span><kbd>/btw</kbd></button>}
    {!props.readOnly && <div ref={composerStack} className="composer-stack">{props.widgets.length > 0 && <div className="extension-widget">{props.widgets.filter((line) => typeof line === "string").map((line, index) => <div key={index}>{line}</div>)}</div>} {statuses.length > 0 && <div className="extension-status">{statuses.join(" · ")}</div>}{activity && <div className="runtime-activity" role="status">{activity}</div>}{!messages.length && props.state.messageCount === 0 && <div className="new-chat-project"><div className="project-picker"><button type="button" className={projectName ? "selected" : undefined} aria-label={projectName ? `Selected project: ${projectName}` : "Choose project"} title={props.projectCwd} onClick={props.onOpenProject}><FolderGit2 size={14} />{projectName ?? "Choose project"}</button>{projectName && props.onClearProject && <button type="button" className="clear-project" aria-label="Clear project" title="Clear project" disabled={props.controlsDisabled || !ownsConversation} onClick={props.onClearProject}><X size={14} /></button>}</div></div>}{!ownsConversation && <div className="conversation-ownership-banner"><div role="status"><p>This conversation is read-only on this client.</p><button type="button" disabled={takingOwnership} onClick={() => void takeOwnership()}>{takingOwnership ? "Taking ownership…" : "Take ownership"}</button>{ownershipError && <p role="alert">{ownershipError}</p>}</div></div>}<div className="composer-interaction" inert={!ownsConversation}><Composer voiceControls={props.voiceTransport && <VoiceControls transport={props.voiceTransport} state={props.state} messages={messages} disabled={props.controlsDisabled || !ownsConversation} />} streaming={props.state.isStreaming} paused={props.state.isPaused} pausing={props.state.isPausing} queued={props.state.pendingMessageCount} pendingMessages={props.state.pendingMessages} onChangePending={props.onChangePending} commands={props.commands} agents={props.agents ?? []} activeAgent={props.activeAgent} agentLocked={props.agentLocked} agentSaved={props.agentSaved} agentUnavailable={props.agentUnavailable} models={props.models} model={props.state.model} fastModeStatus={fastModeStatus} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug ? sessionCache : undefined} contextUsage={props.state.contextUsage} controlsDisabled={props.controlsDisabled || !ownsConversation} draft={props.draft} onDraftChange={props.onDraftChange} focusRequest={props.focusRequest} uploads={props.uploads} onUploadsChange={props.onUploadsChange} restoredDraft={abortedTurn ? { id: `${abortedTurn.assistant.timestamp ?? abortedTurn.assistant.id}:${abortedTurn.prompt}`, value: abortedTurn.prompt } : undefined} onSend={send} onAbort={props.onAbort} onPause={props.onPause} onResume={props.onResume} onOpenTerminal={props.onOpenTerminal} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onToggleFastMode={props.onToggleFastMode} onThinking={props.onThinking} /></div></div>}
    </div>
  </main>;
}

function groupTurns(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[][]>((turns, message) => {
    if (message.role === "user" || message.customType === VOICE_MESSAGE || turns.at(-1)?.at(-1)?.customType === VOICE_MESSAGE || message.customType === "pi-desktop-btw" || turns.length === 0) turns.push([]);
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
    if (message.role === "assistant" && !hasVisibleText(textOf(message.content)) && !hasVisibleText(thinkingOf(message.content)) && message.stopReason !== "aborted" && message.stopReason !== "error" && (hasToolCall || !message.streaming)) return runs;
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

function renderMessages(messages: ChatMessage[], expanded: boolean, compact = true, debug = false, paused = false, showActions = true) {
  return compactCompletedTools(messages, compact && !debug).map(({ message, count }) => <Message key={message.id} message={message} toolCount={count} showActions={showActions} expanded={expanded} debug={debug} paused={paused} />);
}

type ConversationTurnProps = { messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; cwd?: string; debug: boolean; active: boolean; retryable: boolean; paused: boolean; onRetry: Props["onSend"]; onBranch: Props["onBranch"]; onForkAndForget?: Props["onForkAndForget"]; onCreateWorktree?: Props["onCreateWorktree"] };

function ConversationTurnView({ messages, gitDiffs, cwd, debug, active, retryable, paused, onRetry, onBranch, onForkAndForget, onCreateWorktree }: ConversationTurnProps) {
  const changes = useMemo(() => {
    const final = [...messages].reverse().find((message) => message.role === "assistant" && (textOf(message.content).trim() || message.stopReason === "aborted" || message.stopReason === "error"));
    return turnDiff(messages, final ? gitDiffs?.[final.id] : undefined, cwd);
  }, [messages, gitDiffs, cwd]);
  const [retryError, setRetryError] = useState<string>();
  const [retrying, setRetrying] = useState(false); const retryingRef = useRef(false);
  const userIndex = messages.findIndex((message) => message.role === "user");
  const promptContext = userIndex >= 0 && messages[userIndex].deliveryBehavior !== "steer" ? messages[userIndex].promptContext : undefined;

  let finalIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && (textOf(message.content).trim().length > 0 || message.stopReason === "aborted" || message.stopReason === "error")) { finalIndex = index; break; }
  }
  const finalThinking = finalIndex >= 0 ? thinkingOf(messages[finalIndex].content) : "";
  const intermediate = messages.flatMap((message, index) => {
    if (message.role === "user" || message.role === "system") return [];
    if (index !== finalIndex) return [message];
    if (!finalThinking) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;
    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking" as const, thinking: finalThinking }], stopReason: undefined, errorMessage: undefined }];
  });
  const userMessages = messages.filter((message) => message.role === "user");
  const workContent = renderMessages(intermediate, true, true, debug, paused, false);
  const reasoningOnly = compactCompletedTools(intermediate).every(({ message }) => message.role === "assistant" && hasVisibleText(thinkingOf(message.content)) && !hasVisibleText(textOf(message.content)) && message.stopReason !== "error" && message.stopReason !== "aborted");
  const finalMessage = finalIndex >= 0 ? { ...messages[finalIndex], content: textOf(messages[finalIndex].content) } : undefined;
  const turnCacheUsage = messages.reduce((total, message) => {
    if (message.role === "assistant" && message.usage) {
      total.input += message.usage.input;
      total.cacheRead += message.usage.cacheRead; total.cacheWrite += message.usage.cacheWrite ?? 0;
    }
    return total;
  }, { input: 0, cacheRead: 0, cacheWrite: 0 });
  const worktreeResponse = onCreateWorktree && finalMessage && finalMessage.stopReason !== "toolUse" ? () => onCreateWorktree(finalMessage) : undefined;
  const workedFor = formatWorkedFor(userIndex >= 0 ? messages[userIndex].timestamp : messages[0]?.timestamp, finalMessage?.completedAt ?? finalMessage?.timestamp);
  const retryTurn = retryable ? findReplaceableAbortedTurn(messages) : undefined;
  const retryPrompt = retryTurn?.prompt;
  const retryImages = Array.isArray(retryTurn?.user.content) ? retryTurn.user.content.filter((part) => part.type === "image") : [];

  if (messages.length === 1 && messages[0].customType === VOICE_MESSAGE) return <section className="conversation-turn"><Message message={messages[0]} debug={debug} /></section>;
  return <section className="conversation-turn">
    {userMessages.map((message) => <Message key={message.id} message={message} debug={debug} />)}
    {debug && promptContext && <PromptContextBar context={promptContext} />}
    {active || paused ? <div className="active-work-content">{renderMessages(messages.filter((message) => message.role !== "user"), true, false, debug, paused)}</div> : <>
    {workContent.length > 0 && <details className="work-group"><summary>{reasoningOnly ? "Reasoning" : workedFor ? `Worked for ${workedFor}` : "Work"}<ChevronRight size={12} className="work-group-chevron" aria-hidden="true" /></summary><div className={`work-group-content${reasoningOnly ? " reasoning-group-content" : ""}`}>{workContent}</div></details>}
    {finalMessage && <Message message={finalMessage} turnCacheUsage={turnCacheUsage} diff={changes} debug={debug} paused={paused} onBranch={onBranch} onForkAndForget={onForkAndForget} onCreateWorktree={worktreeResponse} retrying={retrying} onRetry={retryPrompt ? () => { if (retryingRef.current) return; retryingRef.current = true; setRetrying(true); setRetryError(undefined); void Promise.resolve(onRetry(retryPrompt, undefined, retryImages)).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => { retryingRef.current = false; setRetrying(false); }); } : undefined} />}
    {retryError && <div className="message-failure retry-error" role="alert">Retry failed: {retryError}</div>}
    {renderMessages(messages.filter((message) => message.role === "system"), false)}
    </>}
    {(active || paused || !finalMessage) && <DiffViewer {...changes} />}
  </section>;
}

const ConversationTurn = memo(ConversationTurnView, (previous, next) => previous.active === next.active
  && previous.retryable === next.retryable && previous.paused === next.paused && previous.debug === next.debug && previous.gitDiffs === next.gitDiffs
  && previous.onRetry === next.onRetry && previous.onBranch === next.onBranch
  && previous.onForkAndForget === next.onForkAndForget
  && previous.onCreateWorktree === next.onCreateWorktree && previous.messages.length === next.messages.length
  && previous.cwd === next.cwd
  && previous.messages.every((message, index) => message === next.messages[index]));
