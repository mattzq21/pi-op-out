import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal, Index, Show } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import { createDependencyEffect, createRef, cssPixels, type StateUpdate } from "../lib/solid";

import { ChevronRight, FolderGit2, LoaderCircle, X } from "lucide-solid";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { cacheHitStats } from "../lib/messages";
import { turnDiff } from "../lib/turnDiff";
import type { AgentProfile, AgentState, ChatMessage, ComposerUpload, GitDiffSnapshots, ImageAttachment, Model, PromptContextInfo, SlashCommand } from "../types";
import { Composer } from "./Composer";
import { ConversationQuestions } from "./ConversationQuestions";
import { DeferredTurn } from "./DeferredTurn";
import { DiffViewer } from "./DiffViewer";
import { Message } from "./Message";
import { PromptContextBar } from "./PromptContextBar";
import { ConversationHostContext } from "../lib/subagentNavigation";

interface Props { transport?: NativeTransport; state: AgentState; messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; debug?: boolean; agents?: AgentProfile[]; activeAgent?: string; agentLocked?: boolean; agentSaved?: boolean; agentUnavailable?: boolean; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: Record<string, string>; projectCwd?: string; readOnly?: boolean; controlsDisabled?: boolean; selectionBtw?: boolean; draft?: string; onDraftChange?: (value: StateUpdate<string>) => void; focusRequest?: number; onActivate?: () => void; uploads?: ComposerUpload[]; onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | boolean | Promise<void | boolean>; onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>; onAbort: () => void | Promise<void>; onPause: () => void | Promise<void>; onResume: () => void | Promise<void>; onOpenTerminal?: () => void; onOpenProject: () => void; onClearProject?: () => void; onBranch: (message: ChatMessage) => void; onForkAndForget?: (message: ChatMessage) => void | Promise<void>; onCreateWorktree?: (message: ChatMessage) => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onToggleFastMode: () => void | Promise<void>; onThinking: (level: string) => void; }

type SelectionBtwTip = { text: string; left: number; top: number; below: boolean };

function canRetry(props: Props, ownsConversation: boolean) {
  return ownsConversation && !props.readOnly && !props.controlsDisabled && !props.state.isStreaming && !props.state.isPaused && !props.state.isPausing;
}

function selectionWithinMessage(range: Range, messages: HTMLElement) {
  const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const body = ancestor?.closest(".message-body");
  return body && messages.contains(body) && body.contains(range.startContainer) && body.contains(range.endContainer);
}

export function ChatView(props: Props) {
  const [ownsConversation, setOwnsConversation] = createSignal((() => props.transport?.ownsConversation() !== false)());
  const [takingOwnership, setTakingOwnership] = createSignal(false);
  const [ownershipError, setOwnershipError] = createSignal<string>();
  createDependencyEffect(() => { const capturedTransport0 = props.transport;
    setOwnsConversation(capturedTransport0?.ownsConversation() !== false);
    setOwnershipError(undefined);
    const unsubscribe = capturedTransport0?.subscribe((event) => {
      if (event.type === "ownership_lost") setOwnsConversation(false);
      if (event.type === "ownership_acquired") { setOwnsConversation(true); setOwnershipError(undefined); }
    });
    return () => { unsubscribe?.(); };
  }, () => [props.transport]);
  const takeOwnership = async () => { const capturedTransport0 = props.transport;
    setTakingOwnership(true); setOwnershipError(undefined);
    try { await capturedTransport0?.takeOwnership(); }
    catch (reason) { setOwnershipError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setTakingOwnership(false); }
  };
  const messagesRef = createRef<HTMLDivElement>(null);
  const followLatest = createRef(true);
  const lastScrollTop = createRef(0);
  const touchY = createRef<number | undefined>(undefined);
  const composerStack = createRef<HTMLDivElement>(null);
  const [selectionBtwTip, setSelectionBtwTip] = createSignal<SelectionBtwTip>();
  const [askingSelection, setAskingSelection] = createSignal(false);
  const [selectionBtwError, setSelectionBtwError] = createSignal(false);
  const messages = () => props.messages;
  const turns = createMemo<ConversationGroup[]>(previous => groupTurns(messages(), previous), []);
  const sessionUsage = createMemo(() => props.messages.reduce((total, message) => ({ input: total.input + (message.usage?.input ?? 0), cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0), cacheWrite: total.cacheWrite + (message.usage?.cacheWrite ?? 0) }), { input: 0, cacheRead: 0, cacheWrite: 0 }));
  const sessionCache = createMemo(() => (cacheHitStats(sessionUsage())));
  const [submittedMessage, setSubmittedMessage] = createSignal<ChatMessage>();
  const send: Props["onSend"] = async (text, behavior, images = []) => { const capturedOwnsConversation = ownsConversation(); const capturedControlsDisabled0 = props.controlsDisabled; const capturedOnSend1 = props.onSend;
    if (!capturedOwnsConversation || capturedControlsDisabled0) return false;
    const message: ChatMessage = { id: crypto.randomUUID(), role: "user", content: [{ type: "text", text }, ...images] };
    setSubmittedMessage(message);
    try { return await capturedOnSend1(text, behavior, images); }
    finally { setSubmittedMessage((current) => current?.id === message.id ? undefined : current); }
  };
  const actions = createRef({ onSend: send, onBranch: props.onBranch, onForkAndForget: props.onForkAndForget, onCreateWorktree: props.onCreateWorktree });
  createComputed(() => { actions.current = { onSend: send, onBranch: props.onBranch, onForkAndForget: props.onForkAndForget, onCreateWorktree: props.onCreateWorktree }; });
  const retryDraft = createRef({ value: props.draft, change: props.onDraftChange, mounted: true });
  createComputed(() => { retryDraft.current.value = props.draft; }); createComputed(() => { retryDraft.current.change = props.onDraftChange; });
  createDependencyEffect(() => { retryDraft.current.mounted = true; return () => { retryDraft.current.mounted = false; }; }, () => []);
  const onRetry: Props["onSend"] = async (...args) => {
    const submittedDraft = retryDraft.current.value; const change = retryDraft.current.change;
    const consumed = submittedDraft === args[0];
    if (consumed) { retryDraft.current.value = ""; change?.(""); }
    const restore = () => { if (consumed && retryDraft.current.mounted && !retryDraft.current.value) change?.(submittedDraft); };
    try { const result = await actions.current.onSend(...args); if (result === false) restore(); return result; }
    catch (reason) { restore(); throw reason; }
  };
  const onBranch: Props["onBranch"] = (message) => actions.current.onBranch(message);
  const onForkAndForget: NonNullable<Props["onForkAndForget"]> = (message) => actions.current.onForkAndForget?.(message);
  const onCreateWorktree: NonNullable<Props["onCreateWorktree"]> = (message) => actions.current.onCreateWorktree?.(message);
  const fastModeStatus = createMemo(() => (props.statuses["pi-desktop-fast-mode"]));
  const mcpLoading = createMemo(() => (props.statuses["pi-desktop-mcp-loading"]));
  const loadingServers = createMemo((): { id: string; name: string }[] => {
    if (!mcpLoading()) return [];
    if (!mcpLoading().startsWith("json:")) return [{ id: "loading", name: mcpLoading().replace(/^Loading /, "") }];
    try {
      const value: unknown = JSON.parse(mcpLoading().slice(5));
      return Array.isArray(value) ? value.filter((server): server is { id: string; name: string } => server && typeof server.id === "string" && typeof server.name === "string") : [];
    } catch { return []; }
  });
  const activity = createMemo(() => (mcpLoading() ? undefined : props.state.activity));
  const projectName = createMemo(() => (props.projectCwd?.split(/[\\/]/).filter(Boolean).at(-1)));
  const retryable = createMemo(() => (canRetry(props, ownsConversation())));
  const abortedTurn = createMemo(() => (retryable() ? findReplaceableAbortedTurn(props.messages) : undefined));
  const scrollToLatest = () => {
    const element = messagesRef.current;
    if (!element || !followLatest.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  };
  createDependencyEffect(scrollToLatest, () => [scrollToLatest, messages(), props.gitDiffs, props.state.isStreaming, mcpLoading(), submittedMessage()]);
  createDependencyEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    messages.style.setProperty("--composer-height", "0px");
    const composer = composerStack.current;
    if (props.readOnly || !composer) return;
    const updateLayout = () => {
      composer.style.paddingLeft = `${messages.clientLeft}px`;
      composer.style.paddingRight = `${messages.offsetWidth - messages.clientWidth - messages.clientLeft}px`;
      messages.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`);
      scrollToLatest();
    };
    updateLayout();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(composer);
    observer.observe(messages);
    const conversation = messages.querySelector(".conversation");
    if (conversation) observer.observe(conversation);
    return () => {
      observer.disconnect();
      messages.style.removeProperty("--composer-height");
      composer.style.removeProperty("padding-left");
      composer.style.removeProperty("padding-right");
    };
  }, () => [props.readOnly, scrollToLatest]);
  const selectionBtwEnabled = createMemo(() => (Boolean(ownsConversation() && props.selectionBtw && !props.readOnly && !props.controlsDisabled && props.commands.some((command) => command.name === "btw"))));
  createDependencyEffect(() => { const capturedSelectionBtwEnabled = selectionBtwEnabled();
    if (!capturedSelectionBtwEnabled) { setSelectionBtwTip(undefined); return; }
    const updateTip = () => {
      const selection = window.getSelection();
      const messages = messagesRef.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !messages) { setSelectionBtwTip(undefined); return; }
      const range = selection.getRangeAt(0);
      if (!selectionWithinMessage(range, messages)) { setSelectionBtwTip(undefined); return; }
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
  }, () => [selectionBtwEnabled()]);
  const askSelectionInBtw = async () => { const capturedSelectionBtwTip = selectionBtwTip(); const capturedAskingSelection = askingSelection(); const capturedState0 = props.state;
    if (!capturedSelectionBtwTip || capturedAskingSelection) return;
    setAskingSelection(true);
    try {
      await send(`/btw ${(capturedSelectionBtwTip)!.text}`, capturedState0.isStreaming ? "followUp" : undefined);
      window.getSelection()?.removeAllRanges();
      setSelectionBtwTip(undefined);
    } catch { setSelectionBtwError(true); }
    finally { setAskingSelection(false); }
  };
  const ConversationContent = () => {
    const renderConcurrentViewStatus = () => ((props.state.viewers ?? 0) > 1 && <div class="concurrent-view-status" role="status">Open in {props.state.viewers} views · Messages and controls are shared</div>);
    const MessagesSection = () => (<div ref={element => { messagesRef.current = element; }} class="messages" aria-live="polite"
      onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) followLatest.current = false; }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => { const y = event.touches[0]?.clientY; if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) followLatest.current = false; touchY.current = y; }}
      oncapture:keydown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) followLatest.current = false; }}
      onScroll={(event) => {
        setSelectionBtwTip(undefined);
        const element = event.currentTarget;
        if (element.scrollTop < lastScrollTop.current) followLatest.current = false;
        else if (element.scrollTop > lastScrollTop.current) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        lastScrollTop.current = element.scrollTop;
      }}><div class="conversation">
        {!messages().length && !mcpLoading() && <div class="empty-chat"><span>πop</span></div>}
        {<Key each={turns()} by={turn => turn.messages[0]?.id ?? "empty"}>{(turn, index) => <DeferredTurn  scrollRoot={messagesRef} eager={index() >= turns().length - 3}><ConversationTurn messages={turn().messages} promptContexts={turn().promptContexts} gitDiffs={props.gitDiffs} cwd={props.projectCwd} debug={props.debug ?? false} active={props.state.isStreaming && index() === turns().length - 1} retryable={retryable() && index() === turns().length - 1} paused={Boolean(props.state.isPaused || props.state.isPausing) && index() === turns().length - 1} onRetry={onRetry} onBranch={onBranch} onForkAndForget={props.onForkAndForget ? onForkAndForget : undefined} onCreateWorktree={props.onCreateWorktree ? onCreateWorktree : undefined} /></DeferredTurn>}</Key>}
        {mcpLoading() && <section class="mcp-pending-turn" aria-label="Message waiting for MCP" aria-busy="true">
          {submittedMessage() && <div class="mcp-pending-message"><Message message={(submittedMessage())!} showActions={false} /></div>}
          <div class="mcp-loading-list" role="status">{props.debug ? <Key each={loadingServers()} by={(server) => server.id}>{(server, _index) => <div class="mcp-loading" ><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading {server().name}</span></div>}</Key> : <div class="mcp-loading"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading MCPs</span></div>}</div>
        </section>}
      </div></div>);
    const renderSelectionBtwTip = () => (selectionBtwTip() && <button type="button" class={`selection-btw-tip${(selectionBtwTip())!.below ? " below" : ""}${selectionBtwError() ? " error" : ""}`} style={{ left: cssPixels((selectionBtwTip())!.left), top: cssPixels((selectionBtwTip())!.top) }} aria-label="Ask about selected text in a side chat with /btw" aria-live="polite" disabled={askingSelection()} onPointerDown={(event) => event.preventDefault()} onClick={() => void askSelectionInBtw()}><span>{askingSelection() ? "Opening side chat…" : selectionBtwError() ? "Could not open side chat" : "Ask in side chat"}</span><kbd>/btw</kbd></button>);
    const ComposerStack = () => {
      const renderNewChatProject = () => (!messages().length && props.state.messageCount === 0 && <div class="new-chat-project"><div class="project-picker"><button type="button" class={projectName() ? "selected" : undefined} aria-label={projectName() ? `Selected project: ${(projectName())!}` : "Choose project"} title={props.projectCwd} onClick={props.onOpenProject}><FolderGit2 size={14} />{projectName() ?? "Choose project"}</button>{projectName() && props.onClearProject && <button type="button" class="clear-project" aria-label="Clear project" title="Clear project" disabled={props.controlsDisabled || !ownsConversation()} onClick={props.onClearProject}><X size={14} /></button>}</div></div>);
      const renderConversationOwnershipBanner = () => (!ownsConversation() && <div class="conversation-ownership-banner"><div role="status"><p>This conversation is read-only on this client.</p><button type="button" disabled={takingOwnership()} onClick={() => void takeOwnership()}>{takingOwnership() ? "Taking ownership…" : "Take ownership"}</button>{ownershipError() && <p role="alert">{(ownershipError())!}</p>}</div></div>);
      const ComposerInteraction = () => (<div class="composer-interaction" inert={!ownsConversation()}><Composer toolbar={renderNewChatProject()} streaming={props.state.isStreaming} compacting={props.state.isCompacting} paused={props.state.isPaused} pausing={props.state.isPausing} queued={props.state.pendingMessageCount} pendingMessages={props.state.pendingMessages} onChangePending={props.onChangePending} commands={props.commands} agents={props.agents ?? []} activeAgent={props.activeAgent} agentLocked={props.agentLocked} agentSaved={props.agentSaved} agentUnavailable={props.agentUnavailable} models={props.models} model={props.state.model} fastModeStatus={fastModeStatus()} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug ? sessionCache() : undefined} contextUsage={props.state.contextUsage} controlsDisabled={props.controlsDisabled || !ownsConversation()} draft={props.draft} onDraftChange={props.onDraftChange} focusRequest={props.focusRequest} uploads={props.uploads} onUploadsChange={props.onUploadsChange} restoredDraft={abortedTurn() ? { id: `${(abortedTurn())!.assistant.timestamp ?? (abortedTurn())!.assistant.id}:${(abortedTurn())!.prompt}`, value: (abortedTurn())!.prompt } : undefined} onSend={send} onAbort={props.onAbort} onPause={props.onPause} onResume={props.onResume} onOpenTerminal={props.onOpenTerminal} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onToggleFastMode={props.onToggleFastMode} onThinking={props.onThinking} /></div>);
      return (<Show when={!props.readOnly}><div ref={element => { composerStack.current = element; }} class="composer-stack">{props.widgets.length > 0 && <div class="extension-widget">{<Index each={props.widgets.filter((line) => typeof line === "string")}>{(line, _index) => <div >{line()}</div>}</Index>}</div>} {activity() && <div class="runtime-activity" role="status">{(activity())!}</div>}{renderConversationOwnershipBanner()}<Show when={ownsConversation()}><div class="composer-questions"><ConversationQuestions transport={props.transport} /></div></Show><ComposerInteraction /></div></Show>);
    };
    return (<div class="conversation-content">
      {renderConcurrentViewStatus()}
      <MessagesSection />
      {renderSelectionBtwTip()}
      <ComposerStack />
    </div>);
  };
  const ConversationShell = () => <main class={`chat-shell${ownsConversation() ? "" : " conversation-unowned"}`} oncapture:focus={() => props.onActivate?.()} oncapture:pointerdown={() => props.onActivate?.()}>
    <ConversationContent />
  </main>;
  return <ConversationHostContext.Provider value={() => props.transport?.currentHostId() ?? "local"}><ConversationShell /></ConversationHostContext.Provider>;
}

type ConversationGroup = { messages: ChatMessage[]; promptContexts: PromptContextInfo[] };
function groupTurns(messages: ChatMessage[], previous: ConversationGroup[] = []) {
  const groups = messages.reduce<ChatMessage[][]>((turns, message) => {
    if (message.role === "user" || message.customType === "pi-desktop-btw" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
    return turns;
  }, []);
  const turns = groups.map(messages => ({ messages, promptContexts: [] as PromptContextInfo[] }));
  for (const [index, group] of groups.entries()) {
    for (const prompt of group) {
      if (prompt.role !== "user" || !prompt.promptContext) continue;
      turns[index].promptContexts.push(prompt.promptContext);
    }
  }
  const prior = new Map(previous.map(turn => [turn.messages[0]?.id, turn]));
  const same = <T,>(left: T[], right: T[]) => left.length === right.length && left.every((item, index) => item === right[index]);
  return turns.map(turn => {
    const old = prior.get(turn.messages[0]?.id);
    if (!old) return turn;
    const messages = same(old.messages, turn.messages) ? old.messages : turn.messages;
    const promptContexts = same(old.promptContexts, turn.promptContexts) ? old.promptContexts : turn.promptContexts;
    return messages === old.messages && promptContexts === old.promptContexts ? old : { messages, promptContexts };
  });
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
    if (invisibleAssistant(message)) return runs;
    const previous = runs.at(-1);
    if (groupRepeated && previous && repeatedCompletedTool(message, previous.message)) {
      const outputs = [textOf(previous.message.content), textOf(message.content)].filter(Boolean);
      previous.message = { ...previous.message, content: outputs.join("\n\n") };
      previous.count += 1;
    } else runs.push({ message, count: 1 });
    return runs;
  }, []);
}

function invisibleAssistant(message: ChatMessage) {
  const hasToolCall = Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall");
  return message.role === "assistant" && !hasVisibleText(textOf(message.content)) && !hasVisibleText(thinkingOf(message.content)) && message.stopReason !== "aborted" && message.stopReason !== "error" && (hasToolCall || !message.streaming);
}

function repeatedCompletedTool(message: ChatMessage, previous: ChatMessage) {
  return message.role === "tool" && message.toolName !== "subagent" && (message.toolStatus ?? "done") === "done" && previous.role === "tool" && (previous.toolStatus ?? "done") === "done" && (previous.toolName || "tool") === (message.toolName || "tool");
}

function finalResponseIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && (textOf(message.content).trim().length > 0 || message.stopReason === "aborted" || message.stopReason === "error")) return index;
  }
  return -1;
}

function turnTiming(messages: ChatMessage[], userIndex: number, finalMessage?: ChatMessage) {
  return formatWorkedFor(userIndex >= 0 ? messages[userIndex].timestamp : messages[0]?.timestamp, finalMessage?.completedAt ?? finalMessage?.timestamp);
}

function retryAttachments(retryTurn: ReturnType<typeof findReplaceableAbortedTurn>) {
  return Array.isArray(retryTurn?.user.content) ? retryTurn.user.content.filter((part) => part.type === "image") : [];
}

function worktreeAction(onCreateWorktree: Props['onCreateWorktree'], finalMessage: ChatMessage | undefined) {
  return onCreateWorktree && finalMessage && finalMessage.stopReason !== "toolUse" ? () => onCreateWorktree(finalMessage) : undefined;
}

function MessageList(props: { messages: ChatMessage[]; expanded: boolean; compact?: boolean; debug?: boolean; paused?: boolean; showActions?: boolean }) {
  return <Key each={compactCompletedTools(props.messages, (props.compact ?? true) && !props.debug)} by={entry => entry.message.id}>{entry => <Message message={entry().message} toolCount={entry().count} showActions={props.showActions ?? true} expanded={props.expanded} debug={props.debug} paused={props.paused} />}</Key>;
}

type ConversationTurnProps = { messages: ChatMessage[]; promptContexts: PromptContextInfo[]; gitDiffs?: GitDiffSnapshots; cwd?: string; debug: boolean; active: boolean; retryable: boolean; paused: boolean; onRetry: Props["onSend"]; onBranch: Props["onBranch"]; onForkAndForget?: Props["onForkAndForget"]; onCreateWorktree?: Props["onCreateWorktree"] };

function ConversationTurn(componentProps: ConversationTurnProps) {
  const patch = createMemo(() => {
    const final = [...componentProps.messages].reverse().find((message) => message.role === "assistant" && (textOf(message.content).trim() || message.stopReason === "aborted" || message.stopReason === "error"));
    const snapshot = final ? componentProps.gitDiffs?.[final.id] : undefined;
    return typeof snapshot === "string" ? snapshot : snapshot?.patch;
  });
  const changes = createMemo(() => turnDiff(patch()));
  const [retryError, setRetryError] = createSignal<string>();
  const [workOpen, setWorkOpen] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false); const retryingRef = createRef(false);
  const userIndex = createMemo(() => (componentProps.messages.findIndex((message) => message.role === "user")));

  const finalIndex = createMemo(() => (finalResponseIndex(componentProps.messages)));
  const finalThinking = createMemo(() => (finalIndex() >= 0 ? thinkingOf(componentProps.messages[finalIndex()].content) : ""));
  const intermediate = createMemo(() => (componentProps.messages.flatMap((message, index) => {
    if (message.role === "user" || message.role === "system") return [];
    if (index !== finalIndex()) return [message];
    if (!finalThinking()) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;
    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking" as const, thinking: finalThinking() }], stopReason: undefined, errorMessage: undefined }];
  })));
  const userMessages = createMemo(() => (componentProps.messages.filter((message) => message.role === "user")));
  const hasWork = createMemo(() => (intermediate().some((message) => !invisibleAssistant(message))));
  const reasoningOnly = createMemo(() => (compactCompletedTools(intermediate()).every(({ message }) => message.role === "assistant" && hasVisibleText(thinkingOf(message.content)) && !hasVisibleText(textOf(message.content)) && message.stopReason !== "error" && message.stopReason !== "aborted")));
  const finalMessage = createMemo(() => (finalIndex() >= 0 ? { ...componentProps.messages[finalIndex()], content: textOf(componentProps.messages[finalIndex()].content) } : undefined));
  const turnCacheUsage = createMemo(() => (componentProps.messages.reduce((total, message) => {
    if (message.role === "assistant" && message.usage) {
      total.input += message.usage.input;
      total.cacheRead += message.usage.cacheRead; total.cacheWrite += message.usage.cacheWrite ?? 0;
    }
    return total;
  }, { input: 0, cacheRead: 0, cacheWrite: 0 })));
  const worktreeResponse = createMemo(() => (worktreeAction(componentProps.onCreateWorktree, finalMessage())));
  const workedFor = createMemo(() => (turnTiming(componentProps.messages, userIndex(), finalMessage())));
  const retryTurn = createMemo(() => (componentProps.retryable ? findReplaceableAbortedTurn(componentProps.messages) : undefined));
  const retryPrompt = createMemo(() => (retryTurn()?.prompt));
  const retryImages = createMemo(() => (retryAttachments(retryTurn())));

  const renderPromptContextBar = () => (<Show when={componentProps.debug}><Index each={componentProps.promptContexts}>{context => <PromptContextBar context={context()} />}</Index></Show>);
  const renderWorkGroup = () => hasWork() && <details class="work-group" open={workOpen()} onToggle={(event) => setWorkOpen(event.currentTarget.open)}><summary>{reasoningOnly() ? "Reasoning" : workedFor() ? `Worked for ${workedFor()}` : "Work"}<ChevronRight size={12} class="work-group-chevron" aria-hidden="true" /></summary>{workOpen() && <div class={`work-group-content${reasoningOnly() ? " reasoning-group-content" : ""}`}><MessageList messages={intermediate()} expanded debug={componentProps.debug} paused={componentProps.paused} showActions={false} /></div>}</details>;
  const renderActiveWorkContent = () => (<Show when={componentProps.active || componentProps.paused} fallback={<>
    {renderWorkGroup()}
    {finalMessage() && <Message message={(finalMessage())!} turnCacheUsage={turnCacheUsage()} diff={changes()} debug={componentProps.debug} paused={componentProps.paused} onBranch={componentProps.onBranch} onForkAndForget={componentProps.onForkAndForget} onCreateWorktree={worktreeResponse()} retrying={retrying()} onRetry={retryPrompt() ? () => { if (retryingRef.current) return; retryingRef.current = true; setRetrying(true); setRetryError(undefined); void Promise.resolve(componentProps.onRetry((retryPrompt())!, undefined, retryImages())).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => { retryingRef.current = false; setRetrying(false); }); } : undefined} />}
    {retryError() && <div class="message-failure retry-error" role="alert">Retry failed: {(retryError())!}</div>}
    <MessageList messages={componentProps.messages.filter(message => message.role === "system")} expanded={false} />
  </>}>
    <div class="active-work-content"><MessageList messages={componentProps.messages.filter(message => message.role !== "user")} expanded compact={false} debug={componentProps.debug} paused={componentProps.paused} /></div>
  </Show>);
  const renderDiffViewer = () => (<Show when={componentProps.active || componentProps.paused || !finalMessage()}><DiffViewer {...changes()} /></Show>);
  return <section class="conversation-turn">
    {<Key each={userMessages()} by={(message) => message.id}>{(message, _index) => <Message  message={message()} debug={componentProps.debug} />}</Key>}
    {renderPromptContextBar()}
    {renderActiveWorkContent()}
    {renderDiffViewer()}
  </section>;
}
