import { NewChatWorktreePicker } from "./NewChatWorktreePicker";
import { z } from "zod";
import { TranscriptPlugins } from "../plugins/transcript";
import type { PluginConversation } from "../plugins/types";
import { stringsSchema, validItems } from "../lib/messageSchemas";
import { required } from "../lib/required";
import { GoalBar } from "./GoalBar";
import { PluginMessageContext } from "../plugins/messages";
import { chatSubmission, trackChatSubmission } from "../lib/chatSubmission";
import { draftUploadsFromImages, stageDraftSubmission, type DraftSubmissionHandle, type DraftSubmissionPayload } from "../lib/draftSubmission";
import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal, Index, onCleanup, Show, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import { createDependencyEffect, createRef, type JSXElement, type StateUpdate } from "../lib/solid";

import { ChevronRight, Folder, LoaderCircle, Monitor, X } from "lucide-solid";
import { findReplaceableAbortedTurn } from "../lib/abortedTurn";
import { markStoppedPrompt, wasPromptStopped } from "../lib/stoppedPrompt";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { cacheHitStats, isContextInjection, isPromptMessage } from "../lib/messages";
import { SubagentResults, subagentRuns } from "./SubagentResults";
import type { AgentProfile, AgentState, ChatMessage, ComposerUpload, ForkSource, ImageAttachment, Model, PromptContextInfo, SlashCommand } from "../types";
import { branchingAvailable, canBranchFrom } from "../lib/branching";
import { Composer, ContainedPicker } from "./Composer";
import { DeferredTurn } from "./DeferredTurn";
import { noDebug, type DebugView } from "../lib/debugFeatures";
import { ResponseNavigator, type ResponseDestination } from "./ResponseNavigator";
import { Message } from "./Message";
import { ConversationImageProject } from "./markdownImages";
import { PromptContextBar } from "./PromptContextBar";
import { ConversationHostContext } from "../lib/subagentNavigation";
import { OLDER_HISTORY, olderHistory } from "../lib/historyWindow";
import { loadOlderHistory } from "../lib/sessionMemory";
import { MessageFileContext } from "../lib/messageFiles";

interface Props { refreshError?: string; capabilityErrors?: string[]; capabilitiesLoading?: boolean; onRetryCapabilities?: () => void; transport?: NativeTransport; agentHostLabel?: string; state: AgentState; messages: ChatMessage[]; debug?: DebugView; agents?: AgentProfile[]; activeAgent?: string; agentLocked?: boolean; agentSaved?: boolean; agentUnavailable?: boolean; modelAliases?: Record<string, string>; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: Record<string, string>; projectCwd?: string; readOnly?: boolean; controlsDisabled?: boolean; draft?: string; onDraftChange?: (value: StateUpdate<string>) => void; focusRequest?: number; onActivate?: () => void; uploads?: ComposerUpload[]; onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[], submission?: DraftSubmissionHandle) => void | boolean | Promise<void | boolean>; onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>; onAbort: () => void | Promise<void>; onPause: () => void | Promise<void>; onResume: () => void | Promise<void>; onOpenTerminal?: () => void; hosts?: Array<{ id: string; name: string; disabled?: boolean }>; onChooseHost?: (hostId: string) => void; onOpenProject: () => void; onClearProject?: () => void; onBranch: (message: ChatMessage) => void; onFork?: (message: ChatMessage) => void | Promise<void>; onForkAndForget?: (message: ChatMessage) => void | Promise<void>; forkSourceName?: string; onOpenForkSource?: (source: ForkSource) => void; revealEntryId?: string; onEntryRevealed?: () => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onToggleFastMode: () => void | Promise<void>; onThinking: (level: string) => void; }

const knownFastMode = new WeakMap<NativeTransport, string>();

function canRetry(props: Props, ownsConversation: boolean) {
  return ownsConversation && !props.readOnly && !props.controlsDisabled && !props.state.isStreaming && !props.state.isPaused && !props.state.isPausing;
}

export function ChatView(props: Props & { transcriptActions?: JSXElement; followConversation?: () => Accessor<PluginConversation>; onNotice?: (title: string, message: string) => void }) {
  const projectCwd = () => props.projectCwd ?? (props.state.sessionId ? props.transport?.currentCwd() : undefined);

  const imageProject = () => {
    const cwd = projectCwd();

    return cwd ? { cwd, hostId: props.transport?.currentHostId() ?? "local" } : undefined;
  };

  const agentDefinitionHost = () => props.agentHostLabel ?? props.transport?.currentHostId();
  const agentReloadScope = () => `${props.transport?.currentHostId()}:${props.state.sessionId}`;

  const reloadAgentDefinitions = async () => {
    const transport = props.transport;

    if (!transport) throw new Error("This session is disconnected");
    await transport.reloadAgentDefinitions(props.state.sessionId);
  };

  const [ownsConversation, setOwnsConversation] = createSignal((() => props.transport?.ownsConversation() !== false)());
  const [terminalAvailable, setTerminalAvailable] = createSignal((() => props.transport?.hasSentMessage() ?? false)());
  const [takingOwnership, setTakingOwnership] = createSignal(false);
  const [ownershipError, setOwnershipError] = createSignal<string>();
  createDependencyEffect(() => { const capturedTransport0 = props.transport;
    setOwnsConversation(capturedTransport0?.ownsConversation() !== false);
    setTerminalAvailable(capturedTransport0?.hasSentMessage() ?? false);
    setOwnershipError(undefined);

    const unsubscribe = capturedTransport0?.subscribe((event) => {
      setTerminalAvailable(capturedTransport0.hasSentMessage());
      // A local disconnect also reports ownership_lost; only a real loss changes ownsConversation.
      if (event.type === "ownership_lost") setOwnsConversation(capturedTransport0.ownsConversation() !== false);

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
  /** The messages without the marker of the older history that is not loaded yet. */
  const messages = createMemo(() => props.messages[0]?.id === OLDER_HISTORY ? props.messages.slice(1) : props.messages);
  const older = createMemo(() => olderHistory(props.messages));
  /** The distance from the bottom to keep while older history comes in above the view. */
  const olderAnchor = createRef<number | undefined>(undefined);

  const loadOlder = () => {
    const element = messagesRef.current; const transport = props.transport;

    if (!element || !transport || !older() || olderAnchor.current !== undefined) return;
    olderAnchor.current = element.scrollHeight - element.scrollTop;
    loadOlderHistory(transport).catch(reason => props.onNotice?.("Could not load older messages", reason instanceof Error ? reason.message : String(reason))).finally(() => requestAnimationFrame(() => {
      const anchor = olderAnchor.current; olderAnchor.current = undefined;

      if (anchor !== undefined && !followLatest.current) { element.scrollTop = element.scrollHeight - anchor; lastScrollTop.current = element.scrollTop; }
      fillView();
    }));
  };

  /** Loads older history while the loaded messages are too short to scroll. */
  const fillView = () => { const element = messagesRef.current;

    if (element && element.scrollHeight <= element.clientHeight) loadOlder(); };
  const split = createMemo(() => splitTranscript(messages(), props.state.isStreaming));
  const turns = createMemo<ConversationGroup[]>(previous => groupTurns(split().transcript, previous), []);
  /** The queued messages, then the sent messages that the daemon has not queued yet. */
  const pendingMessages = createMemo<import("../types").PendingMessage[]>(() => [...props.state.pendingMessages ?? [], ...split().sending.map(message => ({ id: message.id, message: textOf(message.content), behavior: message.deliveryBehavior ?? "followUp", sending: true, images: Array.isArray(message.content) ? message.content.flatMap(part => part.type === "image" && part.data && part.mimeType ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }] : []) : [] }))]);

  const responses = createMemo(() => turns().flatMap(turn => {
    const message = turn.messages[finalResponseIndex(turn.messages)];

    if (!message) return [];

    return [{ turnId: turn.messages[0].id, messageId: message.id, preview: textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 160) || "Response interrupted" } satisfies ResponseDestination];
  }));

  const hasSentPrompt = createMemo(() => messages().some((message) => message.role === "user"));

  const sessionUsage = createMemo(() => {
    let input = 0, cacheRead = 0, cacheWrite = 0;

    for (const usage of [older()?.usage, ...messages().flatMap(message => [message.usage, message.deferredWork?.usage])]) {
      input += usage?.input ?? 0;
      cacheRead += usage?.cacheRead ?? 0;
      cacheWrite += usage?.cacheWrite ?? 0;
    }

    return { input, cacheRead, cacheWrite };
  });

  const sessionCache = createMemo(() => hasSentPrompt() ? cacheHitStats(sessionUsage()) : undefined);
  const pendingSubmission = createMemo(() => chatSubmission(props.transport));

  const stageSubmission = (payload: DraftSubmissionPayload) => {
    const owner = props.transport;

    if (!owner) throw new Error("This conversation has no durable draft destination");

    return stageDraftSubmission(owner, payload);
  };

  const send: Props["onSend"] = async (text, behavior, images = [], staged) => {
    const capturedOnSend = props.onSend;

    if (!ownsConversation() || chatSubmission(props.transport)) {
      await staged?.reject("Message was not submitted");

      return false;
    }

    const durable = staged ?? await stageSubmission({ rawText: text, uploads: draftUploadsFromImages(images), consume: props.draft === text && !props.uploads?.length });

    return trackChatSubmission(durable.owner(), text, images, durable, () => Promise.resolve(capturedOnSend(text, behavior, images, durable)), props.controlsDisabled ? "Getting ready..." : "Sending message…", behavior);
  };

  const actions = createRef({ onSend: send, onBranch: props.onBranch, onFork: props.onFork, onForkAndForget: props.onForkAndForget });
  createComputed(() => { actions.current = { onSend: send, onBranch: props.onBranch, onFork: props.onFork, onForkAndForget: props.onForkAndForget }; });

  const onRetry: Props["onSend"] = async (...args) => {
    const result = await actions.current.onSend(...args);

    if (result === false) throw new Error("Message was not submitted");

    return result;
  };

  const onBranch: Props["onBranch"] = (message) => actions.current.onBranch(message);
  const onFork: NonNullable<Props["onFork"]> = message => actions.current.onFork?.(message);
  const branchAction = createMemo(() => (branchingAvailable(props.state) ? onBranch : undefined));
  const onForkAndForget: NonNullable<Props["onForkAndForget"]> = (message) => actions.current.onForkAndForget?.(message);
  /** The last fast mode status of this chat. A chat switch clears the statuses until Pi reports them again, and the indicator keeps its last state meanwhile. */
  const fastModeStatus = createMemo(() => {
    const status = props.statuses["pi-desktop-fast-mode"];
    const transport = props.transport;

    if (!transport) return status;

    if (status !== undefined) knownFastMode.set(transport, status);

    return status ?? knownFastMode.get(transport);
  });
  /** True for a short time after the controls become unavailable, so a chat switch that reconnects at once does not dim them. */
  const [settling, setSettling] = createSignal((() => Boolean(props.controlsDisabled))());
  createDependencyEffect(() => {
    if (!props.controlsDisabled) { setSettling(false); return; }
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 600);

    return () => clearTimeout(timer);
  }, () => [props.controlsDisabled, props.transport]);
  const mcpLoading = createMemo(() => (props.statuses["pi-desktop-mcp-loading"]));

  const loadingServers = createMemo((): { id: string; name: string }[] => {
    if (!mcpLoading()) return [];

    if (!mcpLoading().startsWith("json:")) return [{ id: "loading", name: mcpLoading().replace(/^Loading /, "") }];

    try {
      return validItems(z.object({ id: z.string(), name: z.string() })).catch([]).parse(JSON.parse(mcpLoading().slice(5)));
    } catch { return []; }
  });

  const activity = createMemo(() => (mcpLoading() ? undefined : props.state.activity));
  const displayedProjectCwd = () => props.projectCwd;
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

  let scrollFrame: number | undefined;

  const scrollToLatest = () => {
    if (scrollFrame !== undefined || !followLatest.current) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      const element = messagesRef.current;

      if (!element || !followLatest.current) return;
      element.scrollTop = element.scrollHeight;
      lastScrollTop.current = element.scrollTop;
    });
  };

  onCleanup(() => { if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame); });

  createDependencyEffect(scrollToLatest, () => [scrollToLatest, messages(), props.state.isStreaming, mcpLoading(), pendingSubmission()]);
  createDependencyEffect(() => { const frame = requestAnimationFrame(fillView);

    return () => cancelAnimationFrame(frame); }, () => [older()]);
  createDependencyEffect(() => { const entryId = props.revealEntryId; const root = messagesRef.current;

    if (!entryId || !root) return;
    const turn = turns().find(candidate => candidate.messages.some(message => message.id === entryId));

    if (!turn) { loadOlder(); return; }
    followLatest.current = false;
    root.querySelector("[data-response-turn=\"" + CSS.escape(turn.messages[0]?.id ?? "") + "\"]")?.dispatchEvent(new CustomEvent("piop:reveal-turn"));
    const frame = requestAnimationFrame(() => {
      const target = root.querySelector("[data-response-id=\"" + CSS.escape(entryId) + "\"]");

      if (!target) return;
      target.scrollIntoView({ block: "center" });
      props.onEntryRevealed?.();
    });

    return () => cancelAnimationFrame(frame);
  }, () => [props.revealEntryId, turns()]);
  createDependencyEffect(() => {
    const messages = messagesRef.current;

    if (!messages) return;
    messages.style.setProperty("--composer-height", "0px");
    const composer = composerStack.current;

    if (props.readOnly || !composer) return;

    const updateLayout = () => {
      composer.style.left = `${messages.clientLeft}px`;
      composer.style.right = `${messages.offsetWidth - messages.clientWidth - messages.clientLeft}px`;
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
      composer.style.removeProperty("left");
      composer.style.removeProperty("right");
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
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;

        if (atBottom) followLatest.current = true;
        else if (element.scrollTop < lastScrollTop.current) followLatest.current = false;
        lastScrollTop.current = element.scrollTop;
        scrollToLatest();

        if (element.scrollTop < element.clientHeight) loadOlder();
      }}><div class="conversation">
        {!messages().length && !mcpLoading() && !pendingSubmission() && <div class="empty-chat"><span>π<sup>op</sup></span></div>}
        {<Key each={turns()} by={turn => turn.messages[0]?.id ?? "empty"}>{(turn, index) => <DeferredTurn navigationId={turn().messages[0]?.id} scrollRoot={messagesRef} eager={index() >= turns().length - 3}><ConversationTurn latest={index() === turns().length - 1} messages={turn().messages} promptContexts={turn().promptContexts} cwd={props.projectCwd} debug={props.debug ?? noDebug} active={props.state.isStreaming && index() === turns().length - 1} retryable={retryable() && index() === turns().length - 1} paused={Boolean(props.state.isPaused || props.state.isPausing) && index() === turns().length - 1} onRetry={onRetry} onBranch={branchAction()} onFork={props.state.canFork !== false && props.onFork ? onFork : undefined} onForkAndForget={props.state.canFork !== false && props.onForkAndForget ? onForkAndForget : undefined} /><Show when={props.state.forkSource && turn().messages.some(message => (message.entryId ?? message.id) === props.state.forkSource?.entryId) ? props.state.forkSource : undefined}>{source => <ForkSourceLink source={source()} name={props.forkSourceName} onOpen={props.onOpenForkSource} />}</Show></DeferredTurn>}</Key>}
        {pendingSubmission() && !mcpLoading() && <section class="mcp-pending-turn" aria-label="Preparing message" aria-busy="true"><div class="mcp-loading" role="status"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>{required(pendingSubmission()).status}</span></div></section>}
        {mcpLoading() && <section class="mcp-pending-turn" aria-label="Message waiting for MCP" aria-busy="true">
          <div class="mcp-loading-list" role="status">{props.debug?.mcpServers ? <Key each={loadingServers()} by={(server) => server.id}>{(server, _index) => <div class="mcp-loading" ><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading {server().name}</span></div>}</Key> : <div class="mcp-loading"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading MCPs</span></div>}</div>
        </section>}
      </div></div>);

    const ComposerStack = () => {
      const selectionDisabled = () => props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission());
      const renderNewChatProject = () => (<Show when={!messages().length && props.state.messageCount === 0}><div class="new-chat-project">{props.hosts && props.onChooseHost && <div class="host-picker"><ContainedPicker label="Host" value={props.transport?.currentHostId() ?? "local"} disabled={Boolean(pendingSubmission())} menuMinWidth={140} anchorLeft icon={<Monitor size={14} />} options={props.hosts.map(host => ({ value: host.id, label: host.name, disabled: host.disabled }))} onChange={hostId => props.onChooseHost?.(hostId)} /></div>}<div class="project-picker"><button type="button" class={projectName() ? "selected" : undefined} aria-label={projectName() ? `Selected project: ${required((projectName()))}` : "Choose project"} data-tooltip={displayedProjectCwd()} disabled={selectionDisabled()} onClick={props.onOpenProject}><Folder size={14} />{projectName() ?? "Choose project"}</button>{projectName() && props.onClearProject && <button type="button" class="clear-project" aria-label="Clear project" data-tooltip="Clear project" disabled={selectionDisabled()} onClick={props.onClearProject}><X size={14} /></button>}</div><Show when={props.transport?.newChatWorktreeOptions()}>{options => <NewChatWorktreePicker options={options()} value={props.transport?.newChatBaseBranch()} disabled={selectionDisabled()} onChange={branch => props.transport?.setNewChatBranch(branch)} />}</Show></div></Show>);
      const renderConversationOwnershipBanner = () => ((takingOwnership() || ownershipError()) && <div class="conversation-ownership-banner"><div>{takingOwnership() && <p role="status">Taking ownership…</p>}{ownershipError() && <p role="alert">{ownershipError()}</p>}</div></div>);
      const ComposerInteraction = () => (<div class="composer-interaction"><Composer recentPrompts={() => props.messages.filter(message => message.role === "user").map(message => textOf(message.content))} submissionDisabled={!ownsConversation() || Boolean(pendingSubmission())} ownershipRequired={!ownsConversation()} onTakeOwnership={takeOwnership} toolbar={renderNewChatProject()} streaming={props.state.isStreaming} compacting={props.state.isCompacting} paused={props.state.isPaused} pausing={props.state.isPausing} queued={props.state.pendingMessageCount} pendingMessages={pendingMessages()} loadPendingImage={props.transport ? (id, index) => required(props.transport).command({ type: "get_queued_image", id, index }, z.object({ data: z.string(), mimeType: z.string() })) : undefined} onChangePending={props.onChangePending} refreshError={props.refreshError} capabilityErrors={props.capabilityErrors} capabilitiesLoading={props.capabilitiesLoading} onRetryCapabilities={props.onRetryCapabilities} commands={props.commands} agents={props.agents ?? []} activeAgent={props.activeAgent} agentLocked={props.agentLocked} agentSaved={props.agentSaved} agentUnavailable={props.agentUnavailable} modelAliases={props.modelAliases} models={props.models} model={props.state.model} fastModeStatus={fastModeStatus()} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug?.cacheHitRate ? sessionCache() : undefined} contextUsage={props.state.contextUsage} controlsDisabled={props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission())} draft={props.draft} onDraftChange={props.onDraftChange} focusRequest={props.focusRequest} uploads={props.uploads} onUploadsChange={props.onUploadsChange} restoredDraft={abortedTurn() ? { id: `${required((abortedTurn())).assistant.timestamp ?? required((abortedTurn())).assistant.id}:${required((abortedTurn())).prompt}`, value: required((abortedTurn())).prompt } : undefined} onStageSubmission={stageSubmission} onSend={send} onAbort={stopResponse} onPause={props.onPause} onResume={props.onResume} terminalDisabled={!terminalAvailable()} onOpenTerminal={props.onOpenTerminal} onJumpToLatest={() => { followLatest.current = true; scrollToLatest(); }} agentHostLabel={agentDefinitionHost()} agentReloadScope={agentReloadScope()} onReloadAgents={props.transport ? reloadAgentDefinitions : undefined} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onToggleFastMode={props.onToggleFastMode} onThinking={props.onThinking} /></div>);

      return (<Show when={!props.readOnly}><div ref={element => { composerStack.current = element; }} class="composer-stack" classList={{ "composer-settling": settling(), "composer-loading": Boolean(props.controlsDisabled) }}><GoalBar value={props.statuses["piop-goal"]} disabled={Boolean(props.controlsDisabled || !ownsConversation() || !props.transport)} onCommand={action => required(props.transport).command({ type: "prompt", message: `/goal ${action}` })} />{props.widgets.length > 0 && <div class="extension-widget">{<Index each={stringsSchema.parse(props.widgets)}>{(line, _index) => <div >{line()}</div>}</Index>}</div>} {activity() && <div class="runtime-activity" role="status">{(activity())}</div>}{renderConversationOwnershipBanner()}<ComposerInteraction /></div></Show>);
    };

    return (<div class="conversation-content">
      <ConversationImageProject.Provider value={imageProject}><MessagesSection /></ConversationImageProject.Provider>
      <ResponseNavigator responses={responses()} scrollRoot={messagesRef} onNavigate={() => { followLatest.current = false; }} />
      <ComposerStack />
    </div>);
  };

  const ConversationShell = () => <main class={`chat-shell${ownsConversation() ? "" : " conversation-unowned"}`} oncapture:focus={() => props.onActivate?.()} oncapture:pointerdown={() => props.onActivate?.()}>
    {props.transcriptActions}
    <ConversationContent />
    <TranscriptPlugins messages={() => messagesRef.current} source={() => ({ hostId: props.transport?.currentHostId() ?? "local", sessionId: props.state.sessionId, title: props.state.sessionName || "Current conversation", messageCount: props.state.messageCount, messages: [...messages()], follow: props.followConversation })} />
  </main>;

  const conversationHost = () => props.transport?.currentHostId() ?? "local";

  return <ConversationHostContext.Provider value={conversationHost}><MessageFileContext.Provider value={{ hostId: conversationHost, cwd: projectCwd, get notify() { return props.onNotice; } }}><PluginMessageContext.Provider value={{ sessionId: () => props.state.sessionId, command: async command => { if (!props.transport) throw new Error("Conversation is unavailable"); return props.transport.command(command); } }}><ConversationShell /></PluginMessageContext.Provider></MessageFileContext.Provider></ConversationHostContext.Provider>;
}

type ConversationGroup = { messages: ChatMessage[]; promptContexts: PromptContextInfo[] };

function startsTurn(message: ChatMessage | undefined) {
  return message !== undefined && isPromptMessage(message);
}

const isSubagentResult = (message: ChatMessage) => message.customType === "piop-subagent-result";

/** A subagent result joins a turn that holds only subagent results, so results with no answer between them share one line. */
function joinsTurn(turn: ChatMessage[], message: ChatMessage) {
  return isSubagentResult(message) && turn.length > 0 && turn.every(isSubagentResult);
}

function sameTurn(turn: ConversationGroup, messages: ChatMessage[], start: number) {
  let context = 0;

  return turn.messages.every((previous, index) => {
    const message = messages[start + index];

    if (message !== previous || (index > 0 && startsTurn(message) && !joinsTurn(turn.messages.slice(0, index), message))) return false;

    if (!isPromptMessage(message) || !message.promptContext) return true;

    return turn.promptContexts[context++] === message.promptContext;
  }) && context === turn.promptContexts.length;
}

function reusableTurns(messages: ChatMessage[], previous: ConversationGroup[]) {
  let start = 0;
  let count = 0;

  for (const turn of previous) {
    const end = start + turn.messages.length;

    if (!turn.messages.length || end > messages.length || (end < messages.length && (!startsTurn(messages[end]) || joinsTurn(turn.messages, messages[end])))) break;

    if (!sameTurn(turn, messages, start)) break;
    start = end;
    count++;
  }

  return { start, count };
}

function turnPromptContexts(messages: ChatMessage[]) {
  const contexts: PromptContextInfo[] = [];

  for (const message of messages) if (isPromptMessage(message) && message.promptContext) contexts.push(message.promptContext);

  return contexts;
}

function associateQueuedContext(messages: ChatMessage[]) {
  const contexts = new Map<number, ChatMessage[]>();

  for (const message of messages) {
    if (message.contextUserTimestamp === undefined) continue;
    const matching = contexts.get(message.contextUserTimestamp) ?? [];
    matching.push(message);
    contexts.set(message.contextUserTimestamp, matching);
  }

  if (!contexts.size) return messages;

  return messages.flatMap(message => {
    if (message.contextUserTimestamp !== undefined) return [];

    if (message.role !== "user" || message.timestamp === undefined) return [message];
    const matching = contexts.get(message.timestamp);

    if (!matching) return [message];
    contexts.delete(message.timestamp);

    return [message, ...matching];
  });
}

/**
 * Splits the messages into the transcript and the sent messages that wait for the daemon's queue.
 * A sent message that the daemon has not queued yet waits in the queue above the message box while an earlier user message still waits for its reply: Pi delivers it only after that reply.
 * An earlier user message waits for its reply while it is still being sent, or while the agent works. A message whose task ended without a reply does not wait.
 */
function splitTranscript(messages: ChatMessage[], working: boolean) {
  let waiting = false;
  const sending: ChatMessage[] = [];
  const transcript = messages.filter(message => {
    if (message.submissionId && message.piopQueueId) return false;

    if (message.role === "assistant") waiting = false;
    else if (message.role === "user") {
      if (message.submissionId && waiting) { sending.push(message); return false; }
      waiting = working || Boolean(message.submissionId);
    }

    return true;
  });

  return { transcript, sending };
}

function groupTurns(messages: ChatMessage[], previous: ConversationGroup[] = []) {
  messages = associateQueuedContext(messages);
  const prefix = reusableTurns(messages, previous);

  if (prefix.start === messages.length && prefix.count === previous.length) return previous;
  const groups: ChatMessage[][] = [];

  for (let index = prefix.start; index < messages.length; index++) {
    const message = messages[index];

    if (groups.length === 0 || (startsTurn(message) && !joinsTurn(groups[groups.length - 1], message))) groups.push([]);
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

function ForkSourceLink(props: { source: ForkSource; name?: string; onOpen?: (source: ForkSource) => void }) {
  const label = () => props.name ? "Branched from “" + props.name + "”" : "Branched from " + props.source.sessionId.slice(0, 8);

  return <div class="fork-source" role="note">{props.onOpen ? <button type="button" class="fork-source-link" onClick={() => props.onOpen?.(props.source)}>{label()}</button> : <span>{label()}</span>}</div>;
}

function invisibleAssistant(message: ChatMessage) {
  const hasToolCall = Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall");

  return message.role === "assistant" && !hasVisibleText(textOf(message.content)) && !hasVisibleText(thinkingOf(message.content)) && message.stopReason !== "aborted" && message.stopReason !== "error" && (hasToolCall || !message.streaming);
}

function repeatedCompletedTool(message: ChatMessage, previous: ChatMessage) {
  return message.role === "tool" && message.toolName !== "spawn_subagents" && (message.toolStatus ?? "done") === "done" && previous.role === "tool" && (previous.toolStatus ?? "done") === "done" && (previous.toolName || "tool") === (message.toolName || "tool");
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

function MessageList(props: { messages: ChatMessage[]; expanded: boolean; compact?: boolean; debug?: DebugView; paused?: boolean; showActions?: boolean }) {
  const entries = createMemo<Array<{ message: ChatMessage; count: number }>>(previous => {
    const retained = new Map(previous.map(entry => [entry.message, entry]));

    return compactCompletedTools(props.messages, (props.compact ?? true) && !props.debug?.toolDetails).map(entry => {
      const prior = retained.get(entry.message);

      return prior?.count === entry.count ? prior : entry;
    });
  }, []);

  return <Key each={entries()} by={entry => entry.message.id}>{entry => <Message message={entry().message} toolCount={entry().count} showActions={props.showActions ?? true} expanded={props.expanded} debug={props.debug} paused={props.paused} />}</Key>;
}

type ConversationTurnProps = { latest?: boolean; messages: ChatMessage[]; promptContexts: PromptContextInfo[]; cwd?: string; debug: DebugView; active: boolean; retryable: boolean; paused: boolean; onRetry: Props["onSend"]; onBranch?: Props["onBranch"]; onFork?: Props["onFork"]; onForkAndForget?: Props["onForkAndForget"]; };

function ConversationTurn(componentProps: ConversationTurnProps) {
  const [retryError, setRetryError] = createSignal<string>();
  const [workOpen, setWorkOpen] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false); const retryingRef = createRef(false);
  const userIndex = createMemo(() => (componentProps.messages.findIndex(isPromptMessage)));

  const finalIndex = createMemo(() => (finalResponseIndex(componentProps.messages)));
  const finalThinking = createMemo(() => (finalIndex() >= 0 ? thinkingOf(componentProps.messages[finalIndex()].content) : ""));

  const intermediate = createMemo(() => (componentProps.messages.flatMap((message, index): ChatMessage[] => {
    if (isPromptMessage(message) || isContextInjection(message) || (message.role === "system" && message.customType !== "compaction")) return [];

    if (index !== finalIndex()) return [message];

    if (!finalThinking()) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;

    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking", thinking: finalThinking() }], stopReason: undefined, errorMessage: undefined }];
  })));

  const userMessages = createMemo(() => (componentProps.messages.filter(message => isPromptMessage(message) && message.customType !== "piop-subagent-result")));
  /** Subagents whose answers started this turn. They show on the turn's "Worked for" line instead of as a message. */
  const finishedSubagents = createMemo(() => componentProps.messages.filter(message => isPromptMessage(message) && message.customType === "piop-subagent-result").flatMap(message => subagentRuns(message.details)));
  // A click on a subagent opens its chat and must not open or close the work group around it.
  const renderFinishedSubagents = () => finishedSubagents().length > 0 && <span class="subagent-finished" onClick={event => event.preventDefault()}><SubagentResults runs={finishedSubagents()} /></span>;
  /** The work that the daemon left out of this turn until the user opens it. */
  const deferredWork = createMemo(() => finalIndex() >= 0 ? componentProps.messages[finalIndex()].deferredWork : undefined);
  const [workError, setWorkError] = createSignal<string>();
  const hasWork = createMemo(() => (Boolean(deferredWork()) || intermediate().some((message) => !invisibleAssistant(message))));
  const openWork = (open: boolean) => {
    setWorkOpen(open);
    const load = open ? componentProps.messages[finalIndex()]?.loadWork : undefined;

    if (!load) return;
    setWorkError(undefined);
    load().catch(reason => setWorkError(reason instanceof Error ? reason.message : String(reason)));
  };
  const reasoningOnly = createMemo(() => deferredWork() ? deferredWork()!.reasoningOnly : (compactCompletedTools(intermediate()).every(({ message }) => message.role === "assistant" && hasVisibleText(thinkingOf(message.content)) && !hasVisibleText(textOf(message.content)) && message.stopReason !== "error" && message.stopReason !== "aborted")));
  const finalSource = createMemo(() => (finalIndex() >= 0 ? componentProps.messages[finalIndex()] : undefined));
  const finalMessage = createMemo(() => (finalIndex() >= 0 ? { ...componentProps.messages[finalIndex()], content: textOf(componentProps.messages[finalIndex()].content) } : undefined));

  const turnCacheUsage = createMemo(() => (componentProps.messages.reduce((total, message) => {
    for (const usage of message.role === "assistant" ? [message.usage, message.deferredWork?.usage] : []) if (usage) {
      total.input += usage.input;
      total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite ?? 0;
    }

    return total;
  }, { input: 0, cacheRead: 0, cacheWrite: 0 })));


  const workedFor = createMemo(() => (turnTiming(componentProps.messages, userIndex(), finalMessage())));
  const retryTurn = createMemo(() => (componentProps.retryable ? findReplaceableAbortedTurn(componentProps.messages) : undefined));
  const retryPrompt = createMemo(() => (retryTurn()?.prompt));
  const retryImages = createMemo(() => (retryAttachments(retryTurn())));

  const firstResponseInputTokens = createMemo(() => {
    const earlyTokens = componentProps.promptContexts[0]?.inputTokens;

    if (earlyTokens !== undefined) return earlyTokens;
    const response = componentProps.messages.find(message => message.role === "assistant");

    return cacheHitStats(response?.deferredWork?.firstUsage ?? response?.usage)?.promptTokens;
  });

  const renderPromptContextBar = () => (<Show when={componentProps.debug.contextBar && firstResponseInputTokens()}>{inputTokens => <Index each={componentProps.promptContexts}>{context => <PromptContextBar context={context()} inputTokens={inputTokens()} />}</Index>}</Show>);
  const renderWorkGroup = () => hasWork() && <details class="work-group" open={workOpen()} onToggle={(event) => openWork(event.currentTarget.open)}><summary>{reasoningOnly() ? "Reasoning" : workedFor() ? `Worked for ${workedFor()}` : "Work"}<ChevronRight size={12} class="work-group-chevron" aria-hidden="true" />{renderFinishedSubagents()}</summary>{workOpen() && <div class={`work-group-content${reasoningOnly() ? " reasoning-group-content" : ""}`}>{deferredWork() ? workError() ? <div class="message-failure" role="alert">Could not load this work: {workError()}</div> : <div class="mcp-loading" role="status"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading work</span></div> : <MessageList messages={intermediate()} expanded debug={componentProps.debug} paused={componentProps.paused} showActions={false} />}</div>}</details>;

  const renderActiveWorkContent = () => (<Show when={componentProps.active || componentProps.paused} fallback={required(<>
    {renderWorkGroup()}
    {finalMessage() && !hasWork() && finishedSubagents().length === 0 && <hr class="turn-divider" />}
    {finalMessage() && <Message message={required((finalMessage()))} turnCacheUsage={turnCacheUsage()} debug={componentProps.debug} paused={componentProps.paused} onBranch={canBranchFrom(finalSource()) ? componentProps.onBranch : undefined} onFork={canBranchFrom(finalSource()) ? componentProps.onFork : undefined} onForkAndForget={componentProps.onForkAndForget} retrying={retrying()} onRetry={retryPrompt() ? () => { if (retryingRef.current) return; retryingRef.current = true; setRetrying(true); setRetryError(undefined); void Promise.resolve(componentProps.onRetry(required((retryPrompt())), undefined, retryImages())).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => { retryingRef.current = false; setRetrying(false); }); } : undefined} />}
    {retryError() && <div class="message-failure retry-error" role="alert">Retry failed: {(retryError())}</div>}
    <MessageList messages={componentProps.messages.filter(message => message.role === "system" && message.customType !== "compaction")} expanded={false} />
  </>)}>
    <div class="active-work-content"><MessageList messages={componentProps.messages.filter(message => !isPromptMessage(message) && !isContextInjection(message))} expanded compact={false} debug={componentProps.debug} paused={componentProps.paused} showActions={false} /></div>
  </Show>);

  return <section class="conversation-turn" classList={{ "latest-turn": componentProps.latest === true }}>
    {<Key each={userMessages()} by={(message) => message.id}>{(message, _index) => <Message  message={message()} debug={componentProps.debug} />}</Key>}
    {!hasWork() && finishedSubagents().length > 0 && <div class="subagent-finished-line">{renderFinishedSubagents()}</div>}
    {renderPromptContextBar()}
    {componentProps.debug.contextInjections && <MessageList messages={componentProps.messages.filter(isContextInjection)} expanded={false} debug={componentProps.debug} />}
    {renderActiveWorkContent()}
  </section>;
}
