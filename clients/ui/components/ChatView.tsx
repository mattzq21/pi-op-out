import { NewChatWorktreePicker } from "./NewChatWorktreePicker";
import { z } from "zod";
import { TranscriptPlugins } from "../plugins/transcript";
import type { PluginConversation } from "../plugins/types";
import { stringsSchema, validItems } from "../lib/messageSchemas";
import { required } from "../lib/required";
import { createGoalControls } from "./GoalControls";
import { SkillMcpStatus, skillMcpConnecting } from "./SkillMcpStatus";
import { PluginMessageContext } from "../plugins/messages";
import { chatSubmission, trackChatSubmission } from "../lib/chatSubmission";
import { draftUploadsFromImages, stageDraftSubmission, type DraftSubmissionHandle, type DraftSubmissionPayload } from "../lib/draftSubmission";
import { Key } from "@solid-primitives/keyed";
import { COMPOSER_FIELD_TAG, type ComposerFieldElement } from "./composerField";
import { appendToDraft, sessionLink, spacedInsert, type SessionDragDetail } from "../lib/sessionDrop";
import { createEffect, createMemo, createRoot, createSignal, Index, onCleanup, Show, untrack, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import { isDaemonRefusal } from "../lib/commandRejected";
import { createDependencyEffect, createRef, type JSXElement, type StateUpdate } from "../lib/solid";

import { ArrowDown, Bot, Folder, LoaderCircle, Monitor, PinOff, User, X } from "lucide-solid";
import { pinId } from "../lib/messagePins";
import { textOf } from "../lib/content";
import { cacheHitStats } from "../lib/messages";
import type { AgentProfile, AgentState, ChatMessage, ComposerUpload, ForkSource, ImageAttachment, Model, SlashCommand } from "../types";
import { Composer, ContainedPicker } from "./Composer";
import { createTranscript, finalResponseIndex, type TranscriptInput } from "./Transcript";
import type { TranscriptCache } from "./transcriptCache";
import type { DebugView } from "../lib/debugFeatures";
import type { DraftSelection } from "../lib/draftState";
import { ResponseNavigator, type ResponseDestination } from "./ResponseNavigator";
import { ScrollIndicator } from "./ScrollIndicator";
import { isMobile } from "../lib/platform";
import { ConversationHostContext } from "../lib/subagentNavigation";
import { OLDER_HISTORY, olderHistory } from "../lib/historyWindow";
import { loadHistoryOutline, loadOlderHistory, useHistoryOutline } from "../lib/sessionMemory";
import { MessageFileContext } from "../lib/messageFiles";
import { applyPlace, savedPlace, savePlace, type ScrollPlace } from "./scrollPlace";

interface Props { loaded?: boolean; transcripts?: TranscriptCache; refreshError?: string; capabilityErrors?: string[]; capabilitiesLoading?: boolean; onRetryCapabilities?: () => void; transport?: NativeTransport; agentHostLabel?: string; state: AgentState; messages: ChatMessage[]; debug?: DebugView; agents?: AgentProfile[]; activeAgent?: string; agentLocked?: boolean; agentSaved?: boolean; agentUnavailable?: boolean; modelAliases?: Record<string, string>; models: Model[]; commands: SlashCommand[]; thinkingLevels: string[]; widgets: string[]; statuses: Record<string, string>; projectCwd?: string; readOnly?: boolean; controlsDisabled?: boolean; draft?: string; onDraftChange?: (value: StateUpdate<string>) => void; draftSelection?: DraftSelection; onDraftSelectionChange?: (selection: DraftSelection) => void; focusRequest?: number; queueHoldRequest?: number; onActivate?: () => void; uploads?: ComposerUpload[]; onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void; onSend: (text: string, behavior?: "steer" | "followUp", images?: ImageAttachment[], submission?: DraftSubmissionHandle) => void | boolean | Promise<void | boolean>; onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>; onAbort: () => void | Promise<void>; onOpenTerminal?: () => void; hosts?: Array<{ id: string; name: string; disabled?: boolean }>; onChooseHost?: (hostId: string) => void; onOpenProject: () => void; onClearProject?: () => void; onBranch: (message: ChatMessage) => void; onFork?: (message: ChatMessage) => void | Promise<void>; forkSourceName?: string; forkPoints?: ReadonlySet<string>; onOpenForkSource?: (source: ForkSource) => void; revealEntryId?: string; onEntryRevealed?: () => void; onAgent?: (name: string) => void; onModel: (model: Model) => void; onToggleFastMode: () => void | Promise<void>; onThinking: (level: string) => void; }

const knownFastMode = new WeakMap<NativeTransport, { status: string; model: string | undefined }>();


export function ChatView(props: Props & { transcriptActions?: JSXElement; followConversation?: () => Accessor<PluginConversation>; onNotice?: (title: string, message: string) => void }) {
  const projectCwd = () => props.projectCwd ?? (props.state.sessionId ? props.transport?.currentCwd() : undefined);

  const agentDefinitionHost = () => props.agentHostLabel ?? props.transport?.currentHostId();
  const agentReloadScope = () => `${props.transport?.currentHostId()}:${props.state.sessionId}`;

  const reloadAgentDefinitions = async () => {
    const transport = props.transport;

    if (!transport) throw new Error("This session is disconnected");
    await transport.reloadAgentDefinitions(props.state.sessionId);
  };

  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>();
  const viewInput = (): TranscriptInput => ({ messages: props.messages, state: props.state, debug: props.debug, readOnly: props.readOnly, scrollRoot: scrollRoot(), cwd: projectCwd(), notify: props.onNotice, forkSourceName: props.forkSourceName, commands: props.commands, actions: { onBranch: props.onBranch, onFork: props.onFork, onOpenForkSource: props.onOpenForkSource } });
  const transcriptTarget = createMemo(() => ({ transport: props.transport, cache: props.transcripts }), undefined, { equals: (left, right) => left?.transport === right.transport && left?.cache === right.cache });
  const transcript = createMemo(() => {
    const { transport, cache } = transcriptTarget();
    const shown = untrack(() => cache && transport ? cache.take(transport, createTranscript) : createTranscript(transport, () => viewInput));
    const restore = shown.use(viewInput);
    onCleanup(() => { restore(); if (cache && transport) cache.release(transport, shown); else shown.dispose(); });

    return shown;
  });
  const ownsConversation = () => transcript().ownsConversation();
  const pins = () => transcript().pins();
  const [terminalAvailable, setTerminalAvailable] = createSignal((() => props.transport?.hasSentMessage() ?? false)());
  const [takingOwnership, setTakingOwnership] = createSignal(false);
  const [ownershipError, setOwnershipError] = createSignal<string>();
  createDependencyEffect(() => { const capturedTransport0 = props.transport;
    setTerminalAvailable(capturedTransport0?.hasSentMessage() ?? false);
    setOwnershipError(undefined);

    const unsubscribe = capturedTransport0?.subscribe((event) => {
      if (event.type === "pinned_messages") return;
      setTerminalAvailable(capturedTransport0.hasSentMessage());

      if (event.type === "ownership_acquired") setOwnershipError(undefined);
    });

    return () => { unsubscribe?.(); };
  }, () => [props.transport]);

  const takeOwnership = async () => { const capturedTransport0 = props.transport;

    if (takingOwnership() || ownsConversation() || props.readOnly) return;
    setTakingOwnership(true); setOwnershipError(undefined);

    try { await capturedTransport0?.takeOwnership(); }
    catch (reason) { if (props.transport === capturedTransport0) { setOwnershipError(reason instanceof Error ? reason.message : String(reason)); composerStack.current?.querySelector<HTMLElement>(COMPOSER_FIELD_TAG)?.blur(); } }
    finally { setTakingOwnership(false); }
  };

  const goalControls = createGoalControls(() => ({ value: props.statuses["piop-goal"], disabled: Boolean(props.controlsDisabled || !ownsConversation() || !props.transport), onCommand: action => required(props.transport).command({ type: "prompt", message: `/goal ${action}` }) }));
  const messagesRef = createRef<HTMLDivElement>(null);
  const restoring = createRef<ScrollPlace | undefined>(untrack(() => props.transport && !props.revealEntryId ? savedPlace(props.transport) : undefined));
  const followLatest = createRef(!restoring.current);
  const holdPlace = createRef<(() => void) | undefined>(undefined);
  const [awayFromLatest, setAwayFromLatest] = createSignal(false);
  const shellRef = createRef<HTMLElement | null>(null);
  const [textSelected, setTextSelected] = createSignal(false);
  const selectionChanged = () => {
    const selection = document.getSelection(); const shell = shellRef.current;
    const selected = Boolean(shell && selection && !selection.isCollapsed && (shell.contains(selection.anchorNode) || shell.contains(selection.focusNode)));

    if (selected === textSelected()) return;
    const root = messagesRef.current; const viewTop = root?.getBoundingClientRect().top;
    const anchor = root && viewTop !== undefined ? Array.from(root.querySelectorAll(".deferred-turn")).find(turn => turn.getBoundingClientRect().bottom > viewTop) : undefined;
    const before = anchor?.getBoundingClientRect().top;
    setTextSelected(selected);

    if (!root || !anchor || before === undefined) return;
    root.scrollTop += anchor.getBoundingClientRect().top - before;
    lastScrollTop.current = root.scrollTop;
  };
  document.addEventListener("selectionchange", selectionChanged);
  onCleanup(() => document.removeEventListener("selectionchange", selectionChanged));
  const [sessionDragOver, setSessionDragOver] = createSignal(false);
  const acceptsSessionDrop = () => !props.readOnly && Boolean(props.onDraftChange);

  const sessionDrag = (event: CustomEvent<SessionDragDetail>) => {
    const detail = event.detail;
    const editor = shellRef.current?.querySelector<ComposerFieldElement>(COMPOSER_FIELD_TAG);
    const usable = editor && !editor.readOnly ? editor : undefined;

    if (detail.phase !== "drop") {
      setSessionDragOver(detail.phase === "over");
      usable?.showDropCaret(detail.phase === "over" ? usable.dropOffset(detail.x, detail.y) : undefined);

      return;
    }
    setSessionDragOver(false);
    editor?.showDropCaret(undefined);

    if (!usable) { props.onDraftChange?.(draft => appendToDraft(draft, sessionLink(detail.session))); (document.activeElement as HTMLElement | null)?.blur(); return; }
    const offset = usable.dropOffset(detail.x, detail.y);
    usable.focus();
    usable.insertAt(offset, spacedInsert(usable.value, offset, sessionLink(detail.session)));
  };
  const measureDistance = () => { const element = messagesRef.current;

    setAwayFromLatest(Boolean(element) && element!.scrollHeight - element!.scrollTop - element!.clientHeight > 120); };
  const jumpToLatest = () => { followLatest.current = true; setAwayFromLatest(false); scrollToLatest(); };
  const lastScrollTop = createRef(0);
  const touchY = createRef<number | undefined>(undefined);
  const composerStack = createRef<HTMLDivElement>(null);
  const messages = createMemo(() => props.messages[0]?.id === OLDER_HISTORY ? props.messages.slice(1) : props.messages);
  const older = createMemo(() => olderHistory(props.messages));
  const olderAnchor = createRef<number | undefined>(undefined);

  const olderRetry = createRef<{ transport: NativeTransport; stop: () => void } | undefined>(undefined);
  onCleanup(() => olderRetry.current?.stop());

  const retryOlderAfterReconnect = (transport: NativeTransport) => {
    if (olderRetry.current?.transport === transport) return;
    olderRetry.current?.stop();
    const stop = transport.subscribe(event => {
      if (event.type !== "connection_restored" && event.type !== "pi_started") return;
      stop();
      if (olderRetry.current?.transport === transport) olderRetry.current = undefined;
      if (props.transport === transport) loadOlder();
    });
    olderRetry.current = { transport, stop };
  };

  const loadOlder = (through?: string) => {
    const element = messagesRef.current; const transport = props.transport;

    if (!element || !transport || !older() || olderAnchor.current !== undefined || olderRetry.current?.transport === transport) return;
    olderAnchor.current = element.scrollHeight - element.scrollTop;
    loadOlderHistory(transport, through).catch(reason => {
      if (!transport.isConnected() || isDaemonRefusal(reason)) retryOlderAfterReconnect(transport);
      else { restoring.current = undefined; setRequestedResponse(undefined); props.onNotice?.("Could not load older messages", reason instanceof Error ? reason.message : String(reason)); }
    }).finally(() => requestAnimationFrame(() => {
      const anchor = olderAnchor.current; olderAnchor.current = undefined;

      if (anchor !== undefined && !followLatest.current) { element.scrollTop = element.scrollHeight - anchor; lastScrollTop.current = element.scrollTop; }
      showRequestedResponse();
      if (holdPlace.current) holdPlace.current();
      else fillView();
    }));
  };

  const fillView = () => { const element = messagesRef.current;

    if (element && element.scrollHeight <= element.clientHeight) loadOlder(); };
  const split = () => transcript().split();
  const turns = () => transcript().turns();
  const pendingMessages = createMemo<import("../types").PendingMessage[]>(() => [...(props.state.pendingMessages ?? []).filter(item => !split().delivered.has(item.id)), ...split().sending.map(message => ({ id: message.id, goalSubmissionId: message.id, message: textOf(message.content), behavior: message.deliveryBehavior ?? "followUp", sending: true, images: Array.isArray(message.content) ? message.content.flatMap(part => part.type === "image" && part.data && part.mimeType ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }] : []) : [] }))]);

  const destinations = new WeakMap<ChatMessage, ResponseDestination>();
  const loadedResponses = createMemo(() => turns().flatMap(turn => {
    const message = turn.messages[finalResponseIndex(turn.messages)];

    if (!message) return [];
    let destination = destinations.get(message);

    if (destination?.turnId !== turn.messages[0].id) destinations.set(message, destination = { turnId: turn.messages[0].id, messageId: message.id, preview: textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 160) || (message.stopReason === "stop" ? "Empty response" : "Response interrupted") });

    return [destination];
  }));

  const olderBefore = createMemo(() => older()?.before);
  const unloadedResponses = useHistoryOutline(() => props.transport, olderBefore);
  createDependencyEffect(() => { const before = olderBefore(); const transport = props.transport;

    if (!before || !transport) return;
    const frame = requestAnimationFrame(() => loadHistoryOutline(transport, before, reason => props.onNotice?.("Could not list older responses", reason instanceof Error ? reason.message : String(reason))));

    return () => cancelAnimationFrame(frame);
  }, () => [olderBefore(), props.transport]);

  const responses = createMemo<ResponseDestination[]>(() => { const loaded = loadedResponses(); const unloaded = unloadedResponses();

    return unloaded.length ? [...unloaded.map(item => ({ messageId: item.id, preview: item.preview })), ...loaded] : loaded; });

  let forkedTurns = new WeakMap<object, string | null>();
  const forkPoints = createMemo(() => { forkedTurns = new WeakMap(); return props.forkPoints; });
  const forkedResponses = createMemo(() => { const points = forkPoints(); const result = new Set<string>();

    if (!points?.size) return result;

    for (const turn of turns()) {
      let forked = forkedTurns.get(turn);

      if (forked === undefined) {
        const final = turn.messages[finalResponseIndex(turn.messages)];
        forked = final && turn.messages.some(message => points.has(message.entryId ?? message.id)) ? final.id : null;
        forkedTurns.set(turn, forked);
      }

      if (forked) result.add(forked);
    }

    for (const item of unloadedResponses()) if (points.has(item.id) || item.compactions?.some(id => points.has(id))) result.add(item.id);

    return result; }, undefined, { equals: (previous, next) => previous.size === next.size && [...next].every(id => previous.has(id)) });

  const [requestedResponse, setRequestedResponse] = createSignal<string>();
  const showRequestedResponse = () => { const id = untrack(requestedResponse); const root = messagesRef.current;

    if (!id || !root || olderAnchor.current !== undefined) return;
    const turn = untrack(turns).find(candidate => candidate.messages.some(message => message.id === id || message.entryId === id));

    if (!turn) {
      if (untrack(older)) loadOlder(id);
      else setRequestedResponse(undefined);

      return;
    }
    setRequestedResponse(undefined);
    followLatest.current = false;
    const turnElement = root.querySelector<HTMLElement>("[data-response-turn=\"" + CSS.escape(turn.messages[0]?.id ?? "") + "\"]");
    turnElement?.dispatchEvent(new Event("piop:reveal-turn"));
    requestAnimationFrame(() => {
      const target = root.querySelector<HTMLElement>("[data-response-id=\"" + CSS.escape(id) + "\"]") ?? turnElement;

      if (!target) return;
      followLatest.current = false;
      root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
      lastScrollTop.current = root.scrollTop;
    });
  };
  createDependencyEffect(showRequestedResponse, () => [requestedResponse(), turns()]);

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
  const sendingSubmission = createMemo(() => {
    const submission = pendingSubmission();
    if (!submission || submission.message.deliveryBehavior || props.state.queueHeld) return undefined;
    const compact = /^\/compact(?:\s|$)/.test(textOf(submission.message.content));

    return compact && props.state.isCompacting ? undefined : submission;
  });

  const delivering = createMemo(() => Boolean(sendingSubmission()) || split().transcript.some(message => message.submissionId));
  const starting = createMemo(() => delivering() || split().waiting);
  const delivered = () => new Promise<void>(resolve => createRoot(dispose => {
    const finish = () => { dispose(); resolve(); };
    const timer = setTimeout(finish, 30000);
    onCleanup(() => clearTimeout(timer));
    createEffect(() => { if (!delivering()) finish(); });
  }));
  const abort = async () => {
    if (delivering()) await delivered();
    if (props.state.isStreaming || props.state.isCompacting || split().waiting) await props.onAbort();
  };

  const stageSubmission = (payload: DraftSubmissionPayload) => {
    const owner = props.transport;

    if (!owner) throw new Error("This conversation has no durable draft destination");

    return stageDraftSubmission(owner, payload);
  };

  const send: Props["onSend"] = async (text, behavior, images = [], staged) => {
    const capturedOnSend = props.onSend;

    if (!ownsConversation()) {
      await staged?.reject("Message was not submitted");

      return false;
    }

    const durable = staged ?? await stageSubmission({ rawText: text, uploads: draftUploadsFromImages(images), consume: props.draft === text && !props.uploads?.length });
    const queued = behavior ?? (chatSubmission(durable.owner()) ? "followUp" : undefined);
    const shown = queued ?? (split().waiting || props.state.queueHeld || (props.state.pendingMessages?.length ?? 0) > 0 ? "followUp" : undefined);

    return trackChatSubmission(durable.owner(), text, images, durable, () => Promise.resolve(capturedOnSend(text, queued, images, durable)), props.controlsDisabled ? "Getting ready..." : "Sending message…", shown);
  };

  const [pinReveal, setPinReveal] = createSignal<string>();

  const fastModeStatus = createMemo(() => {
    const status = props.statuses["pi-desktop-fast-mode"];
    const transport = props.transport;

    if (!transport) return status;
    const model = props.state.model ? `${props.state.model.provider}/${props.state.model.id}` : undefined;

    if (status !== undefined) knownFastMode.set(transport, { status, model });

    const known = knownFastMode.get(transport);

    return status ?? (known?.model === model ? known?.status : undefined);
  });
  const [settling, setSettling] = createSignal((() => Boolean(props.controlsDisabled))());
  createDependencyEffect(() => {
    if (!props.controlsDisabled) { setSettling(false); return; }
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 600);

    return () => clearTimeout(timer);
  }, () => [props.controlsDisabled, props.transport]);
  const mcpLoading = createMemo(() => (props.statuses["pi-desktop-mcp-loading"]));
  const skillMcpLoading = createMemo(() => skillMcpConnecting(props.statuses["piop-skill-mcp"]));
  const sendingStatus = createMemo(() => mcpLoading() ? undefined : skillMcpLoading() ? "Skill's MCP connecting…" : sendingSubmission()?.status);

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

  let scrollFrame: number | undefined;

  const scrollToLatest = () => {
    if (scrollFrame !== undefined || !followLatest.current) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      const element = messagesRef.current;

      if (!element || !followLatest.current) return;
      element.scrollTop = element.scrollHeight;
      lastScrollTop.current = element.scrollTop;
      measureDistance();
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
  createDependencyEffect(() => { const entryId = pinReveal(); const root = messagesRef.current;

    if (!entryId || !root) return;
    const turn = turns().find(candidate => candidate.messages.some(message => pinId(message) === entryId));

    if (!turn) {
      if (older()) loadOlder();
      else { setPinReveal(undefined); props.onNotice?.("Pinned message not found", "The message is not in this branch of the chat."); }

      return;
    }
    followLatest.current = false;
    root.querySelector("[data-response-turn=\"" + CSS.escape(turn.messages[0]?.id ?? "") + "\"]")?.dispatchEvent(new CustomEvent("piop:reveal-turn"));
    const frame = requestAnimationFrame(() => {
      setPinReveal(undefined);
      root.querySelector("[data-pin-id=\"" + CSS.escape(entryId) + "\"]")?.scrollIntoView({ block: "start" });
    });

    return () => cancelAnimationFrame(frame);
  }, () => [pinReveal(), turns()]);
  createDependencyEffect(() => { const root = messagesRef.current; const content = root?.querySelector(".conversation"); const shell = shellRef.current;

    if (!root || !content || !shell || !restoring.current || typeof ResizeObserver === "undefined") return;
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const stop = () => { restoring.current = undefined; holdPlace.current = undefined; observer.disconnect(); for (const type of inputs) shell.removeEventListener(type, stop, true); };
    const hold = () => {
      const place = restoring.current;

      if (!place || followLatest.current) { stop(); return; }
      if (applyPlace(root, place)) { lastScrollTop.current = root.scrollTop; measureDistance(); return; }
      if (untrack(older)) { loadOlder(); return; }
      if (untrack(messages).length) { stop(); followLatest.current = true; scrollToLatest(); }
    };
    holdPlace.current = hold;
    const observer = new ResizeObserver(hold);
    observer.observe(content);
    for (const type of inputs) shell.addEventListener(type, stop, { capture: true, passive: true });

    return stop;
  }, () => []);
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
      if (followLatest.current) { messages.scrollTop = messages.scrollHeight; lastScrollTop.current = messages.scrollTop; }
      measureDistance();
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
    const MessagesSection = () => (<div ref={element => { messagesRef.current = element; setScrollRoot(element); }} class="messages" aria-live="polite"
      onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) followLatest.current = false; }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => { const y = event.touches[0]?.clientY;

      if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) followLatest.current = false; touchY.current = y; }}
      oncapture:keydown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) followLatest.current = false; }}
      onClick={(event) => { if (event.target instanceof Element && event.target.closest(".prompt-context")) followLatest.current = false; }}
      onScroll={(event) => {
        const element = event.currentTarget;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        const movedUp = element.scrollTop < lastScrollTop.current;

        if (atBottom) followLatest.current = true;
        else if (movedUp) followLatest.current = false;
        lastScrollTop.current = element.scrollTop;
        if (props.transport) savePlace(props.transport, element, followLatest.current);
        scrollToLatest();
        measureDistance();

        if (movedUp && element.scrollTop < element.clientHeight) loadOlder();
      }}><div class="conversation">
        {props.loaded !== false && !messages().length && !mcpLoading() && !pendingSubmission() && <div class="empty-chat"><span>π<sup>op</sup></span></div>}
        {transcript().element}
        {mcpLoading() && <section class="mcp-pending-turn" aria-label="Message waiting for MCP" aria-busy="true">
          <div class="mcp-loading-list" role="status">{props.debug?.mcpServers ? <Key each={loadingServers()} by={(server) => server.id}>{(server, _index) => <div class="mcp-loading" ><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading {server().name}</span></div>}</Key> : <div class="mcp-loading"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading MCPs</span></div>}</div>
        </section>}
      </div></div>);

    const ComposerStack = () => {
      const selectionDisabled = () => props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission());
      const renderNewChatProject = () => (<Show when={props.loaded !== false && !messages().length && props.state.messageCount === 0}><div class="new-chat-project">{props.hosts && props.onChooseHost && <div class="host-picker"><ContainedPicker label="Host" value={props.transport?.currentHostId() ?? "local"} disabled={Boolean(pendingSubmission())} menuMinWidth={140} anchorLeft icon={<Monitor size={14} />} options={props.hosts.map(host => ({ value: host.id, label: host.name, disabled: host.disabled }))} onChange={hostId => props.onChooseHost?.(hostId)} /></div>}<div class="project-picker"><button type="button" class={projectName() ? "selected" : undefined} aria-label={projectName() ? `Selected project: ${required((projectName()))}` : "Choose project"} data-tooltip={displayedProjectCwd()} disabled={selectionDisabled()} onClick={props.onOpenProject}><Folder size={14} />{projectName() ?? "Choose project"}</button>{projectName() && props.onClearProject && <button type="button" class="clear-project" aria-label="Clear project" data-tooltip="Clear project" disabled={selectionDisabled()} onClick={props.onClearProject}><X size={14} /></button>}</div><Show when={props.transport?.newChatWorktreeOptions()}>{options => <NewChatWorktreePicker options={options()} value={props.transport?.newChatBaseBranch()} disabled={selectionDisabled()} onChange={branch => props.transport?.setNewChatBranch(branch)} />}</Show></div></Show>);
      const renderConversationOwnershipBanner = () => ((takingOwnership() || ownershipError()) && <div class="conversation-ownership-banner"><div>{takingOwnership() && <p role="status">Taking ownership…</p>}{ownershipError() && <p role="alert">{ownershipError()}</p>}</div></div>);
      const ComposerInteraction = () => (<div class="composer-interaction"><Composer goal={goalControls} recentPrompts={() => props.messages.filter(message => message.role === "user").map(message => textOf(message.content))} submissionDisabled={!ownsConversation()} ownershipRequired={!ownsConversation()} onTakeOwnership={takeOwnership} toolbar={renderNewChatProject()} sendingStatus={sendingStatus()} starting={starting()} streaming={props.state.isStreaming} compacting={props.state.isCompacting} queued={props.state.pendingMessageCount} pendingMessages={pendingMessages()} queueHeld={props.state.queueHeld === true} onHoldQueue={props.transport && props.state.sessionId ? held => required(props.transport).command({ type: "hold_queue", held }).then(() => undefined) : undefined} loadPendingImage={props.transport ? (id, index) => required(props.transport).command({ type: "get_queued_image", id, index }, z.object({ data: z.string(), mimeType: z.string() })) : undefined} onChangePending={props.onChangePending} refreshError={props.refreshError} capabilityErrors={props.capabilityErrors} capabilitiesLoading={props.capabilitiesLoading} onRetryCapabilities={props.onRetryCapabilities} commands={props.commands} agents={props.agents ?? []} activeAgent={props.activeAgent} agentLocked={props.agentLocked} agentSaved={props.agentSaved} agentUnavailable={props.agentUnavailable} modelAliases={props.modelAliases} models={props.models} model={props.state.model} fastModeStatus={fastModeStatus()} thinkingLevel={props.state.thinkingLevel} thinkingLevels={props.thinkingLevels} sessionCache={props.debug?.cacheHitRate ? sessionCache() : undefined} contextUsage={props.state.contextUsage} controlsDisabled={props.controlsDisabled || !ownsConversation() || Boolean(pendingSubmission())} queueControlsDisabled={props.controlsDisabled || !ownsConversation()} draft={props.draft} onDraftChange={props.onDraftChange} draftSelection={props.draftSelection} onDraftSelectionChange={props.onDraftSelectionChange} focusRequest={props.focusRequest} queueHoldRequest={props.queueHoldRequest} uploads={props.uploads} onUploadsChange={props.onUploadsChange} onStageSubmission={stageSubmission} onSend={send} onAbort={abort} terminalDisabled={!terminalAvailable()} onOpenTerminal={props.onOpenTerminal} onJumpToLatest={jumpToLatest} agentHostLabel={agentDefinitionHost()} agentReloadScope={agentReloadScope()} onReloadAgents={props.transport ? reloadAgentDefinitions : undefined} onAgent={props.onAgent ?? (() => undefined)} onModel={props.onModel} onToggleFastMode={props.onToggleFastMode} onThinking={props.onThinking} /></div>);

      return (<Show when={!props.readOnly}><div ref={element => { composerStack.current = element; }} class="composer-stack" classList={{ "composer-settling": settling(), "composer-loading": Boolean(props.controlsDisabled) }}><Show when={awayFromLatest() && !props.state.isStreaming}><button type="button" class="jump-to-latest" aria-label="Scroll to latest" onClick={jumpToLatest}><ArrowDown size={16} /></button></Show>{props.widgets.length > 0 && <div class="extension-widget">{<Index each={stringsSchema.parse(props.widgets)}>{(line, _index) => <div >{line()}</div>}</Index>}</div>} {activity() && <div class="runtime-activity" role="status">{(activity())}</div>}{renderConversationOwnershipBanner()}<ComposerInteraction /></div></Show>);
    };

    return (<div class="conversation-content">
      <MessagesSection />
      {isMobile && <ScrollIndicator scrollRoot={messagesRef} />}
      <Show when={pins().length > 0}><PinnedMessages /></Show>
      <SkillMcpStatus value={props.statuses["piop-skill-mcp"]} disabled={props.readOnly || props.controlsDisabled || !ownsConversation() || !props.transport} onAction={(name, action) => required(props.transport).command({ type: "skill_mcp", name, action })} />
      <ResponseNavigator responses={responses()} forked={forkedResponses()} scrollRoot={messagesRef} onNavigate={() => { followLatest.current = false; }} onReveal={id => { followLatest.current = false; setRequestedResponse(id); }} />
      <ComposerStack />
    </div>);
  };

  const PinnedMessages = () => {
    const frame = createRef<HTMLDivElement | null>(null);
    const bar = createRef<HTMLDivElement | null>(null);
    createDependencyEffect(() => { const element = bar.current; const area = frame.current; const root = messagesRef.current;

      if (!element || !area || !root || typeof ResizeObserver === "undefined") return;
      let reserved = 0;
      const reserve = (height: number) => {
        if (height === reserved) return;
        const change = height - reserved;
        reserved = height;
        const before = root.scrollTop;
        if (height) root.style.setProperty("--pins-height", `${height}px`);
        else root.style.removeProperty("--pins-height");
        root.scrollTop = before + change;
        lastScrollTop.current = root.scrollTop;
      };
      const update = () => {
        reserve(element.offsetHeight);
        area.style.left = `${root.clientLeft}px`;
        area.style.right = `${root.offsetWidth - root.clientWidth - root.clientLeft}px`;
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(element);
      observer.observe(root);

      return () => { observer.disconnect(); reserve(0); };
    }, () => []);

    return <div ref={element => { frame.current = element; }} class="pinned-messages-frame"><div ref={element => { bar.current = element; }} class="pinned-messages" role="list" aria-label="Pinned messages">
      <Key each={pins()} by={pin => pin.entryId}>{pin => <div class="pinned-message" classList={{ "pinned-prompt": pin().role === "prompt" }} role="listitem">
        <button type="button" class="pinned-message-text" aria-label={(pin().role === "prompt" ? "Prompt: " : "Response: ") + (pin().text || "Attachment")} onClick={() => setPinReveal(pin().entryId)}>{pin().role === "prompt" ? <User size={15} aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}<span>{pin().text || <em>Attachment</em>}</span></button>
        <button type="button" class="pinned-message-unpin" aria-label="Unpin message" data-tooltip="Unpin" onClick={() => void transcript().unpin(pin().entryId)}><PinOff size={15} /></button>
      </div>}</Key>
    </div></div>;
  };

  const ConversationShell = () => <main class={`chat-shell${ownsConversation() ? "" : " conversation-unowned"}`} ref={element => { shellRef.current = element; }} classList={{ "session-drop-over": sessionDragOver() }} data-text-selected={textSelected() ? "" : undefined} data-session-drop-zone={acceptsSessionDrop() ? "" : undefined} on:piop-session-drag={sessionDrag} oncapture:focus={() => props.onActivate?.()} oncapture:pointerdown={() => props.onActivate?.()}>
    {props.transcriptActions}
    <ConversationContent />
    <TranscriptPlugins messages={() => messagesRef.current} source={() => ({ hostId: props.transport?.currentHostId() ?? "local", sessionId: props.state.sessionId, title: props.state.sessionName || "Current conversation", messageCount: props.state.messageCount, messages: [...messages()], follow: props.followConversation })} />
  </main>;

  const conversationHost = () => props.transport?.currentHostId() ?? "local";

  return <ConversationHostContext.Provider value={conversationHost}><MessageFileContext.Provider value={{ hostId: conversationHost, cwd: projectCwd, get notify() { return props.onNotice; } }}><PluginMessageContext.Provider value={{ sessionId: () => props.state.sessionId, command: async command => { if (!props.transport) throw new Error("Conversation is unavailable"); return props.transport.command(command); } }}><ConversationShell /></PluginMessageContext.Provider></MessageFileContext.Provider></ConversationHostContext.Provider>;
}
