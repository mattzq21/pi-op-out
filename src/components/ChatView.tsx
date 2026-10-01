import { z } from "zod";
import { stringsSchema, validItems } from "../lib/messageSchemas";
import { gitPatchSchema } from "../lib/diffSchemas";
import { required } from "../lib/required";
import { GoalBar } from "./GoalBar";
import { ReviewNavigationContext } from "./ReviewLink";
import { acknowledgeChatSubmission, chatSubmission, trackChatSubmission } from "../lib/newChatWorktree";
import { Key, Rerun } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal, Index, Show } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import { createDependencyEffect, createRef, type StateUpdate } from "../lib/solid";

import { ChevronRight, FolderGit2, LoaderCircle, X } from "lucide-solid";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";
import { markStoppedPrompt, wasPromptStopped } from "../lib/stoppedPrompt";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { cacheHitStats } from "../lib/messages";
import { turnDiff } from "../lib/turnDiff";
import type { AgentProfile, AgentState, ChatMessage, ComposerUpload, GitDiffSnapshots, ImageAttachment, Model, PromptContextInfo, SlashCommand } from "../types";
import { NewChatBranchPicker } from "./NewChatBranchPicker";
import { Composer } from "./Composer";
import { ConversationQuestions } from "./ConversationQuestions";
import { DeferredTurn } from "./DeferredTurn";
import { DiffViewer } from "./DiffViewer";
import { Message } from "./Message";
import { PromptContextBar } from "./PromptContextBar";
import { ConversationHostContext } from "../lib/subagentNavigation";

interface Props { transport?: NativeTransport; state: AgentState; messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; debug?: boolean; agents?: AgentProfile[]; activeAgent?: string; agentLocked?: boolean; agentSaved?: boolean; agentUnavailable?: boolean; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: Record<string, string>; projectCwd?: string; readOnly?: boolean; controlsDisabled?: boolean; draft?: string; onDraftChange?: (value: StateUpdate<string>) => void; focusRequest?: number; onActivate?: () => void; uploads?: ComposerUpload[]; onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | boolean | Promise<void | boolean>; onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>; onAbort: () => void | Promise<void>; onPause: () => void | Promise<void>; onResume: () => void | Promise<void>; onOpenTerminal?: () => void; onOpenProject: () => void; onClearProject?: () => void; onProjectBranch?: (path: string) => Promise<void>; onBranch: (message: ChatMessage) => void; canRollback?: boolean; onForkAndForget?: (message: ChatMessage, restoreWorktree?: boolean) => void | Promise<void>; onCreateWorktree?: (message: ChatMessage) => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onToggleFastMode: () => void | Promise<void>; onThinking: (level: string) => void; }


function canRetry(props: Props, ownsConversation: boolean) {
  return ownsConversation && !props.readOnly && !props.controlsDisabled && !props.state.isStreaming && !props.state.isPaused && !props.state.isPausing;
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

    if (takingOwnership() || ownsConversation() || props.readOnly) return;
    setTakingOwnership(true); setOwnershipError(undefined);

    try { await capturedTransport0?.takeOwnership(); }
    catch (reason) { if (props.transport === capturedTransport0) { setOwnershipError(reason instanceof Error ? reason.message : String(reason)); composerStack.current?.querySelector("textarea")?.blur(); } }
    finally { setTakingOwnership(false); }
  };

  const messagesRef = createRef<HTMLDivElement>(null);
  const followLatest = createRef(true);
  const lastScrollTop = createRef(0);
  const touchY = createRef<number | undefined>(undefined);
  const composerStack = createRef<HTMLDivElement>(null);
  const messages = () => props.messages;
  const turns = createMemo<ConversationGroup[]>(previous => groupTurns(messages(), previous), []);

  const sessionUsage = createMemo(() => {
    let input = 0, cacheRead = 0, cacheWrite = 0;

    for (const message of props.messages) {
      input += message.usage?.input ?? 0;
      cacheRead += message.usage?.cacheRead ?? 0;
      cacheWrite += message.usage?.cacheWrite ?? 0;
    }

    return { input, cacheRead, cacheWrite };
  });

  const sessionCache = createMemo(() => (cacheHitStats(sessionUsage())));
  const pendingSubmission = createMemo(() => chatSubmission(props.transport));
  createComputed(() => acknowledgeChatSubmission(props.transport, messages()));
  const [submittedMessage, setSubmittedMessage] = createSignal<ChatMessage>();
  const mcpPendingMessage = () => pendingSubmission()?.message ?? submittedMessage();

  const send: Props["onSend"] = async (text, behavior, images = []) => { const capturedOwnsConversation = ownsConversation(); const capturedControlsDisabled0 = props.controlsDisabled; const capturedOnSend1 = props.onSend;

    if (!capturedOwnsConversation || capturedControlsDisabled0) return false;
    const message: ChatMessage = { id: crypto.randomUUID(), role: "user", content: [{ type: "text", text }, ...images] };
    setSubmittedMessage(message);
    const owner = props.transport;
    const submit = () => Promise.resolve(capturedOnSend1(text, behavior, images));

    try { return await (owner ? trackChatSubmission(owner, text, images, messages(), Boolean(behavior), submit) : submit()); }
    finally { setSubmittedMessage((current) => current?.id === message.id ? undefined : current); }
  };

  const actions = createRef({ onSend: send, onBranch: props.onBranch, onForkAndForget: props.onForkAndForget, onCreateWorktree: props.onCreateWorktree });
  createComputed(() => { actions.current = { onSend: send, onBranch: props.onBranch, onForkAndForget: props.onForkAndForget, onCreateWorktree: props.onCreateWorktree }; });
  const retryDraft = createRef({ value: props.draft, change: props.onDraftChange, mounted: true });
  createComputed(() => { retryDraft.current.value = props.draft; }); createComputed(() => { retryDraft.current.change = props.onDraftChange; });
  createDependencyEffect(() => { retryDraft.current.mounted = true;

  return () => { retryDraft.current.mounted = false; }; }, () => []);

  const onRetry: Props["onSend"] = async (...args) => {
    const submittedDraft = retryDraft.current.value; const change = retryDraft.current.change;
    const consumed = submittedDraft === args[0];

    if (consumed) { retryDraft.current.value = ""; change?.(""); }

    const restore = () => { if (consumed && retryDraft.current.mounted && !retryDraft.current.value) change?.(submittedDraft); };

    try { const result = await actions.current.onSend(...args);

    if (result === false) restore();

    return result; }
    catch (reason) { restore(); throw reason; }
  };

  const onBranch: Props["onBranch"] = (message) => actions.current.onBranch(message);
  const onForkAndForget: NonNullable<Props["onForkAndForget"]> = (message, restoreWorktree) => actions.current.onForkAndForget?.(message, restoreWorktree);
  const onCreateWorktree: NonNullable<Props["onCreateWorktree"]> = (message) => actions.current.onCreateWorktree?.(message);
  const fastModeStatus = createMemo(() => (props.statuses["pi-desktop-fast-mode"]));
  const mcpLoading = createMemo(() => (props.statuses["pi-desktop-mcp-loading"]));

  const loadingServers = createMemo((): { id: string; name: string }[] => {
    if (!mcpLoading()) return [];

    if (!mcpLoading().startsWith("json:")) return [{ id: "loading", name: mcpLoading().replace(/^Loading /, "") }];

    try {
      return validItems(z.object({ id: z.string(), name: z.string() })).catch([]).parse(JSON.parse(mcpLoading().slice(5)));
    } catch { return []; }
  });

  const activity = createMemo(() => (mcpLoading() ? undefined : props.state.activity));
  const displayedProjectCwd = () => pendingSubmission()?.selection?.listing.path ?? props.projectCwd;
  const projectName = createMemo(() => (displayedProjectCwd()?.split(/[\\/]/).filter(Boolean).at(-1)));
  const retryable = createMemo(() => (canRetry(props, ownsConversation())));

  const abortedTurn = createMemo(() => {
    const turn = retryable() ? findReplaceableAbortedTurn(props.messages) : undefined;

    return turn && !wasPromptStopped(props.state.sessionId, turn.user) ? turn : undefined;
  });

  const stopResponse = () => {
    markStoppedPrompt(props.state.sessionId, props.messages);

    return props.onAbort();
  };

  const scrollToLatest = () => {
    const element = messagesRef.current;

    if (!element || !followLatest.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  };

  createDependencyEffect(scrollToLatest, () => [scrollToLatest, messages(), props.gitDiffs, props.state.isStreaming, mcpLoading(), submittedMessage(), pendingSubmission()]);
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

  const ConversationContent = () => {
    const MessagesSection = () => (<div ref={element => { messagesRef.current = element; }} class="messages" aria-live="polite"
      onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) followLatest.current = false; }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => { const y = event.touches[0]?.clientY;

      if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) followLatest.current = false; touchY.current = y; }}
      oncapture:keydown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) followLatest.current = false; }}
      onScroll={(event) => {
        const element = event.currentTarget;

        if (element.scrollTop < lastScrollTop.current) followLatest.current = false;
        else if (element.scrollTop > lastScrollTop.current) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        lastScrollTop.current = element.scrollTop;
      }}><div class="conversation">
        {!messages().length && !mcpLoading() && !pendingSubmission() && <div class="empty-chat"><span>πop</span></div>}
        {<Key each={turns()} by={turn => turn.messages[0]?.id ?? "empty"}>{(turn, index) => <DeferredTurn  scrollRoot={messagesRef} eager={index() >= turns().length - 3}><ConversationTurn messages={turn().messages} promptContexts={turn().promptContexts} gitDiffs={props.gitDiffs} cwd={props.projectCwd} debug={props.debug ?? false} active={props.state.isStreaming && index() === turns().length - 1} retryable={retryable() && index() === turns().length - 1} paused={Boolean(props.state.isPaused || props.state.isPausing) && index() === turns().length - 1} onRetry={onRetry} onBranch={onBranch} canRollback={props.canRollback} onForkAndForget={props.onForkAndForget ? onForkAndForget : undefined} onCreateWorktree={props.onCreateWorktree ? onCreateWorktree : undefined} /></DeferredTurn>}</Key>}
        {pendingSubmission() && !mcpLoading() && <section class="mcp-pending-turn" aria-label="Preparing message" aria-busy="true"><Message message={required(pendingSubmission()).message} showActions={false} /><div class="mcp-loading" role="status"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>{required(pendingSubmission()).status}</span></div></section>}
        {mcpLoading() && <section class="mcp-pending-turn" aria-label="Message waiting for MCP" aria-busy="true">
          {mcpPendingMessage() && <div class="mcp-pending-message"><Message message={required(mcpPendingMessage())} showActions={false} /></div>}
          <div class="mcp-loading-list" role="status">{props.debug ? <Key each={loadingServers()} by={(server) => server.id}>{(server, _index) => <div class="mcp-loading" ><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading {server().name}</span></div>}</Key> : <div class="mcp-loading"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading MCPs</span></div>}</div>
        </section>}
      </div></div>);

    const ComposerStack = () => {
      const selectionDisabled = () => props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission());
      const renderNewChatBranch = () => <Show when={Boolean(props.projectCwd && props.onProjectBranch)}><Rerun on={() => props.transport}>{(_owner) => <NewChatBranchPicker transport={props.transport} cwd={required(props.projectCwd)} hostId={props.transport?.currentHostId() ?? "local"} disabled={props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission())} onSelect={required(props.onProjectBranch)} />}</Rerun></Show>;
      const renderNewChatProject = () => (<Show when={!messages().length && props.state.messageCount === 0}><div class="new-chat-project"><div class="project-picker"><button type="button" class={projectName() ? "selected" : undefined} aria-label={projectName() ? `Selected project: ${required((projectName()))}` : "Choose project"} title={displayedProjectCwd()} disabled={selectionDisabled()} onClick={props.onOpenProject}><FolderGit2 size={14} />{projectName() ?? "Choose project"}</button>{projectName() && props.onClearProject && <button type="button" class="clear-project" aria-label="Clear project" title="Clear project" disabled={selectionDisabled()} onClick={props.onClearProject}><X size={14} /></button>}</div>{renderNewChatBranch()}</div></Show>);
      const renderConversationOwnershipBanner = () => ((takingOwnership() || ownershipError()) && <div class="conversation-ownership-banner"><div>{takingOwnership() && <p role="status">Taking ownership…</p>}{ownershipError() && <p role="alert">{ownershipError()}</p>}</div></div>);
      const ComposerInteraction = () => (<div class="composer-interaction"><Composer ownershipRequired={!ownsConversation()} onTakeOwnership={takeOwnership} toolbar={renderNewChatProject()} streaming={props.state.isStreaming} compacting={props.state.isCompacting} paused={props.state.isPaused} pausing={props.state.isPausing} queued={props.state.pendingMessageCount} pendingMessages={props.state.pendingMessages} onChangePending={props.onChangePending} commands={props.commands} agents={props.agents ?? []} activeAgent={props.activeAgent} agentLocked={props.agentLocked} agentSaved={props.agentSaved} agentUnavailable={props.agentUnavailable} models={props.models} model={props.state.model} fastModeStatus={fastModeStatus()} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug ? sessionCache() : undefined} contextUsage={props.state.contextUsage} controlsDisabled={props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission())} draft={props.draft} onDraftChange={props.onDraftChange} focusRequest={props.focusRequest} uploads={props.uploads} onUploadsChange={props.onUploadsChange} restoredDraft={abortedTurn() ? { id: `${required((abortedTurn())).assistant.timestamp ?? required((abortedTurn())).assistant.id}:${required((abortedTurn())).prompt}`, value: required((abortedTurn())).prompt } : undefined} onSend={send} onAbort={stopResponse} onPause={props.onPause} onResume={props.onResume} onOpenTerminal={props.onOpenTerminal} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onToggleFastMode={props.onToggleFastMode} onThinking={props.onThinking} /></div>);

      return (<Show when={!props.readOnly}><div ref={element => { composerStack.current = element; }} class="composer-stack"><GoalBar value={props.statuses["piop-goal"]} disabled={Boolean(props.controlsDisabled || !ownsConversation() || !props.transport)} onCommand={action => required(props.transport).command({ type: "prompt", message: `/goal ${action}` })} />{props.widgets.length > 0 && <div class="extension-widget">{<Index each={stringsSchema.parse(props.widgets)}>{(line, _index) => <div >{line()}</div>}</Index>}</div>} {activity() && <div class="runtime-activity" role="status">{(activity())}</div>}{renderConversationOwnershipBanner()}<Show when={ownsConversation()}><div class="composer-questions"><ConversationQuestions transport={props.transport} /></div></Show><ComposerInteraction /></div></Show>);
    };

    return (<div class="conversation-content">
      <MessagesSection />
      <ComposerStack />
    </div>);
  };

  const ConversationShell = () => <main class={`chat-shell${ownsConversation() ? "" : " conversation-unowned"}`} oncapture:focus={() => props.onActivate?.()} oncapture:pointerdown={() => props.onActivate?.()}>
    <ConversationContent />
  </main>;

  return <ConversationHostContext.Provider value={() => props.transport?.currentHostId() ?? "local"}><ReviewNavigationContext.Provider value={async id => { if (!props.transport) throw new Error("Conversation is unavailable"); await props.transport.command({ type: "prompt", message: `/pi-orchestration-review-open ${id}` }); }}><ConversationShell /></ReviewNavigationContext.Provider></ConversationHostContext.Provider>;
}

type ConversationGroup = { messages: ChatMessage[]; promptContexts: PromptContextInfo[] };

function startsTurn(message: ChatMessage | undefined) {
  return message?.role === "user" || message?.customType === "pi-desktop-btw";
}

function sameTurn(turn: ConversationGroup, messages: ChatMessage[], start: number) {
  let context = 0;

  return turn.messages.every((previous, index) => {
    const message = messages[start + index];

    if (message !== previous || (index > 0 && startsTurn(message))) return false;

    if (message.role !== "user" || !message.promptContext) return true;

    return turn.promptContexts[context++] === message.promptContext;
  }) && context === turn.promptContexts.length;
}

function reusableTurns(messages: ChatMessage[], previous: ConversationGroup[]) {
  let start = 0;
  let count = 0;

  for (const turn of previous) {
    const end = start + turn.messages.length;

    if (!turn.messages.length || end > messages.length || (end < messages.length && !startsTurn(messages[end]))) break;

    if (!sameTurn(turn, messages, start)) break;
    start = end;
    count++;
  }

  return { start, count };
}

function turnPromptContexts(messages: ChatMessage[]) {
  const contexts: PromptContextInfo[] = [];

  for (const message of messages) if (message.role === "user" && message.promptContext) contexts.push(message.promptContext);

  return contexts;
}

function groupTurns(messages: ChatMessage[], previous: ConversationGroup[] = []) {
  const prefix = reusableTurns(messages, previous);

  if (prefix.start === messages.length && prefix.count === previous.length) return previous;
  const groups: ChatMessage[][] = [];

  for (let index = prefix.start; index < messages.length; index++) {
    const message = messages[index];

    if (startsTurn(message) || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(message);
  }

  const turns = groups.map(messages => ({ messages, promptContexts: turnPromptContexts(messages) }));
  const prior = new Map(previous.slice(prefix.count).map(turn => [turn.messages[0]?.id, turn]));
  const same = <T,>(left: T[], right: T[]) => left.length === right.length && left.every((item, index) => item === right[index]);

  return [...previous.slice(0, prefix.count), ...turns.map(turn => {
    const old = prior.get(turn.messages[0]?.id);

    if (!old) return turn;
    const messages = same(old.messages, turn.messages) ? old.messages : turn.messages;
    const promptContexts = same(old.promptContexts, turn.promptContexts) ? old.promptContexts : turn.promptContexts;

    return messages === old.messages && promptContexts === old.promptContexts ? old : { messages, promptContexts };
  })];
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
  const entries = createMemo<Array<{ message: ChatMessage; count: number }>>(previous => {
    const retained = new Map(previous.map(entry => [entry.message, entry]));

    return compactCompletedTools(props.messages, (props.compact ?? true) && !props.debug).map(entry => {
      const prior = retained.get(entry.message);

      return prior?.count === entry.count ? prior : entry;
    });
  }, []);

  return <Key each={entries()} by={entry => entry.message.id}>{entry => <Message message={entry().message} toolCount={entry().count} showActions={props.showActions ?? true} expanded={props.expanded} debug={props.debug} paused={props.paused} />}</Key>;
}

type ConversationTurnProps = { messages: ChatMessage[]; promptContexts: PromptContextInfo[]; gitDiffs?: GitDiffSnapshots; cwd?: string; debug: boolean; active: boolean; retryable: boolean; paused: boolean; onRetry: Props["onSend"]; onBranch: Props["onBranch"]; canRollback?: boolean; onForkAndForget?: Props["onForkAndForget"]; onCreateWorktree?: Props["onCreateWorktree"] };

function ConversationTurn(componentProps: ConversationTurnProps) {
  const patch = createMemo(() => {
    const final = [...componentProps.messages].reverse().find((message) => message.role === "assistant" && (textOf(message.content).trim() || message.stopReason === "aborted" || message.stopReason === "error"));
    const snapshot = final ? componentProps.gitDiffs?.[final.id] : undefined;

    return gitPatchSchema.parse(snapshot).patch;
  });

  const changes = createMemo(() => turnDiff(patch()));
  const [retryError, setRetryError] = createSignal<string>();
  const [workOpen, setWorkOpen] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false); const retryingRef = createRef(false);
  const userIndex = createMemo(() => (componentProps.messages.findIndex((message) => message.role === "user")));

  const finalIndex = createMemo(() => (finalResponseIndex(componentProps.messages)));
  const finalThinking = createMemo(() => (finalIndex() >= 0 ? thinkingOf(componentProps.messages[finalIndex()].content) : ""));

  const intermediate = createMemo(() => (componentProps.messages.flatMap((message, index): ChatMessage[] => {
    if (message.role === "user" || (message.role === "system" && message.customType !== "compaction")) return [];

    if (index !== finalIndex()) return [message];

    if (!finalThinking()) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;

    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking", thinking: finalThinking() }], stopReason: undefined, errorMessage: undefined }];
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

  const renderActiveWorkContent = () => (<Show when={componentProps.active || componentProps.paused} fallback={required(<>
    {renderWorkGroup()}
    {finalMessage() && <Message message={required((finalMessage()))} turnCacheUsage={turnCacheUsage()} diff={changes()} debug={componentProps.debug} paused={componentProps.paused} onBranch={componentProps.onBranch} canRollback={componentProps.canRollback} onForkAndForget={componentProps.onForkAndForget} onCreateWorktree={worktreeResponse()} retrying={retrying()} onRetry={retryPrompt() ? () => { if (retryingRef.current) return; retryingRef.current = true; setRetrying(true); setRetryError(undefined); void Promise.resolve(componentProps.onRetry(required((retryPrompt())), undefined, retryImages())).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => { retryingRef.current = false; setRetrying(false); }); } : undefined} />}
    {retryError() && <div class="message-failure retry-error" role="alert">Retry failed: {(retryError())}</div>}
    <MessageList messages={componentProps.messages.filter(message => message.role === "system" && message.customType !== "compaction")} expanded={false} />
  </>)}>
    <div class="active-work-content"><MessageList messages={componentProps.messages.filter(message => message.role !== "user")} expanded compact={false} debug={componentProps.debug} paused={componentProps.paused} showActions={false} /></div>
  </Show>);

  const renderDiffViewer = () => (<Show when={componentProps.active || componentProps.paused || !finalMessage()}><DiffViewer {...changes()} /></Show>);

  return <section class="conversation-turn">
    {<Key each={userMessages()} by={(message) => message.id}>{(message, _index) => <Message  message={message()} debug={componentProps.debug} />}</Key>}
    {renderPromptContextBar()}
    {renderActiveWorkContent()}
    {renderDiffViewer()}
  </section>;
}
