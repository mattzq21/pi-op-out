import { Key } from "@solid-primitives/keyed";
import { createEffect, createMemo, createRoot, createSignal, getOwner, Index, onCleanup, Show, untrack, type Accessor, type Owner } from "solid-js";
import { ChevronRight, LoaderCircle } from "lucide-solid";
import type { NativeTransport } from "../lib/nativeTransport";
import type { AgentState, ChatMessage, ForkSource, PromptContextInfo } from "../types";
import { createRef } from "../lib/solid";
import { required } from "../lib/required";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { cacheHitStats, isContextInjection, isPromptMessage, toolTitle } from "../lib/messages";
import { branchingAvailable, canBranchFrom } from "../lib/branching";
import { noDebug, type DebugView } from "../lib/debugFeatures";
import { OLDER_HISTORY } from "../lib/historyWindow";
import { formatElapsed } from "../lib/duration";
import { resolveMessageEntry } from "../lib/resolveMessageEntry";
import { MessagePinContext, PIN_LIMIT, pinId, pinnedMessagesSchema, type MessagePin, type MessagePins } from "../lib/messagePins";
import { MessageFileContext } from "../lib/messageFiles";
import { ConversationHostContext } from "../lib/subagentNavigation";
import { PluginMessageContext } from "../plugins/messages";
import { ConversationImageProject } from "./markdownImages";
import { SubagentResults, subagentRuns } from "./SubagentResults";
import { PromptContextBar } from "./PromptContextBar";
import { DeferredTurn } from "./DeferredTurn";
import { Message } from "./Message";

type TranscriptTransport = NativeTransport;

export type TranscriptActions = { onBranch?: (message: ChatMessage) => void; onFork?: (message: ChatMessage) => void | Promise<void>; onForkAndForget?: (message: ChatMessage) => void | Promise<void>; onOpenForkSource?: (source: ForkSource) => void };

/** What a transcript shows and the view it shows in. scrollRoot: the scrolling element of the view; without it, the turns that are not drawn at once wait. */
export type TranscriptInput = { messages: ChatMessage[]; state: AgentState; debug?: DebugView; readOnly?: boolean; scrollRoot?: HTMLElement | null; cwd?: string; notify?: (title: string, message: string) => void; forkSourceName?: string; actions: TranscriptActions };

/**
 * The turns of one chat, drawn into an element that can move between views. A chat drawn while it is not shown opens without drawing it again.
 * use: shows the transcript with the input of a view. The returned function gives back the input it had before.
 */
export type Transcript = {
  element: HTMLElement;
  split: Accessor<TranscriptSplit>;
  turns: Accessor<ConversationGroup[]>;
  pins: Accessor<MessagePin[]>;
  ownsConversation: Accessor<boolean>;
  unpin: (entryId: string) => Promise<void>;
  use: (input: Accessor<TranscriptInput>) => () => void;
  dispose: () => void;
};

/** input: makes the input that the transcript has while no view uses it. It runs inside the transcript. owner: gives the contexts of the app. */
export function createTranscript(transport: TranscriptTransport | undefined, input: () => Accessor<TranscriptInput>, owner: Owner | null = getOwner()): Transcript {
  return createRoot(dispose => {
    const [source, setSource] = createSignal(input());
    const current = () => source()();
    const field = <K extends keyof TranscriptInput>(key: K) => createMemo(() => current()[key]);
    const debug = createMemo(() => current().debug ?? noDebug, noDebug, { equals: (left, right) => Object.keys(right).every(key => left[key as keyof DebugView] === right[key as keyof DebugView]) });
    const rawMessages = field("messages"); const state = field("state"); const readOnly = field("readOnly"); const scrollRoot = field("scrollRoot"); const cwd = field("cwd"); const forkSourceName = field("forkSourceName");
    const isStreaming = createMemo(() => state().isStreaming); const queueHeld = createMemo(() => state().queueHeld === true);
    const canFork = createMemo(() => state().canFork !== false); const forkSource = createMemo(() => state().forkSource);
    const branching = createMemo(() => branchingAvailable(state())); const sessionId = createMemo(() => state().sessionId);
    const has = (key: keyof TranscriptActions) => createMemo(() => Boolean(current().actions[key]));
    const hasFork = has("onFork"); const hasForkAndForget = has("onForkAndForget"); const hasOpenForkSource = has("onOpenForkSource");

    const [ownsConversation, setOwnsConversation] = createSignal(transport?.ownsConversation?.() !== false);
    const [pins, setPins] = createSignal<MessagePin[]>([]);
    const stop = transport?.subscribe(event => {
      if (event.type === "pinned_messages") setPins(pinnedMessagesSchema.parse(event.pins));
      // A local disconnect also reports ownership_lost; only a real loss changes ownsConversation.
      else if (event.type === "ownership_lost") setOwnsConversation(transport.ownsConversation?.() !== false);
      else if (event.type === "ownership_acquired") setOwnsConversation(true);
    });
    onCleanup(() => stop?.());

    const messages = createMemo(() => rawMessages()[0]?.id === OLDER_HISTORY ? rawMessages().slice(1) : rawMessages());
    const split = createMemo(() => splitTranscript(messages(), isStreaming(), queueHeld()));
    const turns = createMemo<ConversationGroup[]>(previous => groupTurns(split().transcript, previous), []);
    const retryable = createMemo(() => ownsConversation() && !readOnly() && !isStreaming());
    const hostId = () => transport?.currentHostId() ?? "local";
    const notice = (title: string, reason: unknown) => current().notify?.(title, reason instanceof Error ? reason.message : String(reason));

    /** Runs the failed or stopped response again in Pi, which hides the failed attempt from the model. */
    const onRetry = async (message: ChatMessage) => {
      if (!transport) throw new Error("Conversation is unavailable");
      // The saved history can show before the chat has begun to start its Pi; connect joins a start in progress.
      if (!transport.isConnected()) await transport.connect();
      await transport.command({ type: "retry_response", entryId: await resolveMessageEntry(transport, message) });
    };

    const pinnedIds = createMemo(() => new Set(pins().map(pin => pin.entryId)));
    const unpin = (entryId: string) => {
      if (!transport) { notice("Could not unpin message", "Conversation is unavailable"); return Promise.resolve(); }

      return transport.command({ type: "unpin_message", entryId }).then(() => undefined, reason => notice("Could not unpin message", reason));
    };
    const messagePins: MessagePins = {
      pinned: id => pinnedIds().has(id),
      toggle: async (message, text) => {
        if (pinnedIds().has(pinId(message))) return unpin(pinId(message));

        try {
          if (!transport) throw new Error("Conversation is unavailable");
          if (pins().length >= PIN_LIMIT) throw new Error(`Only ${PIN_LIMIT} messages can be pinned. Unpin one first.`);
          if (message.timestamp === undefined) throw new Error("This message has no time, so its place in the chat is unknown");
          await transport.command({ type: "pin_message", entryId: await resolveMessageEntry(transport, message), role: message.role === "user" ? "prompt" : "response", text, timestamp: message.timestamp });
        } catch (reason) { notice("Could not pin message", reason); }
      },
    };

    const onBranch = (message: ChatMessage) => current().actions.onBranch?.(message);
    const onFork = (message: ChatMessage) => current().actions.onFork?.(message);
    const onForkAndForget = (message: ChatMessage) => current().actions.onForkAndForget?.(message);
    const onOpenForkSource = (forkSource: ForkSource) => current().actions.onOpenForkSource?.(forkSource);
    const imageProject = createMemo(() => { const path = cwd(); return path ? { cwd: path, hostId: hostId() } : undefined; }, undefined, { equals: (left, right) => left?.cwd === right?.cwd && left?.hostId === right?.hostId });
    const pluginMessages = { sessionId: () => sessionId(), command: async (command: Parameters<TranscriptTransport["command"]>[0]) => { if (!transport) throw new Error("Conversation is unavailable"); return transport.command(command); } };

    let element: HTMLElement | undefined;
    // The providers give their content lazily; reading it draws the turns now, with the contexts.
    const view: unknown = <ConversationHostContext.Provider value={hostId}><MessageFileContext.Provider value={{ hostId, cwd, get notify() { return current().notify; } }}><PluginMessageContext.Provider value={pluginMessages}><MessagePinContext.Provider value={messagePins}><ConversationImageProject.Provider value={imageProject}>
      <div ref={node => { element = node; }} class="conversation-turns">
        <Key each={turns()} by={turn => turn.messages[0]?.id ?? "empty"}>{(turn, index) => <DeferredTurn navigationId={turn().messages[0]?.id} scrollRoot={scrollRoot} eager={index() >= turns().length - 3}><ConversationTurn latest={index() === turns().length - 1} messages={turn().messages} promptContexts={turn().promptContexts} debug={debug()} active={isStreaming() && index() === turns().length - 1} steered={turns()[index() + 1]?.messages[0]?.deliveryBehavior === "steer"} retryable={retryable() && index() === turns().length - 1} onRetry={onRetry} onBranch={branching() ? onBranch : undefined} onFork={canFork() && hasFork() ? onFork : undefined} onForkAndForget={canFork() && hasForkAndForget() && ownsConversation() ? onForkAndForget : undefined} forkSource={forkSource()} forkSourceName={forkSourceName()} onOpenForkSource={hasOpenForkSource() ? onOpenForkSource : undefined} /></DeferredTurn>}</Key>
      </div>
    </ConversationImageProject.Provider></MessagePinContext.Provider></PluginMessageContext.Provider></MessageFileContext.Provider></ConversationHostContext.Provider>;
    if (typeof view === "function") (view as () => unknown)();

    const use = (next: Accessor<TranscriptInput>) => {
      // A chat can take its conversation without an event, such as a new chat that loads its draft, so a view reads it when it shows the chat.
      setOwnsConversation(transport?.ownsConversation?.() !== false);
      const previous = untrack(source);
      setSource(() => next);

      return () => { if (untrack(source) === next) setSource(() => previous); };
    };

    return { element: required(element), split, turns, pins, ownsConversation, unpin, use, dispose };
  }, owner ?? undefined);
}

export type ConversationGroup = { messages: ChatMessage[]; promptContexts: PromptContextInfo[] };

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
 * While the queue is on hold, every sent message waits in the queue: the daemon keeps it there.
 * A message sent as a steer or follow-up while the agent worked also waits there, even after the reply started: Pi queues it.
 * A queued message that starts a turn stays in the conversation, and its queue entry is left out of the queue (started), so it does not move to the queue while Pi takes it.
 */
export type TranscriptSplit = ReturnType<typeof splitTranscript>;

function splitTranscript(messages: ChatMessage[], working: boolean, held: boolean) {
  let waiting = false;
  const sending: ChatMessage[] = [];
  const started = new Set<string>();
  const delivered = new Set(messages.flatMap(message => !message.submissionId && message.piopQueueId ? [message.piopQueueId] : []));
  const transcript = messages.filter(message => {
    if (message.submissionId && message.piopQueueId) {
      if (delivered.has(message.piopQueueId) || waiting || held || message.deliveryBehavior) return false;
      started.add(message.piopQueueId);
    }

    if (message.role === "assistant") waiting = false;
    else if (message.role === "user") {
      if (message.submissionId && (waiting || held || message.deliveryBehavior)) { sending.push(message); return false; }
      waiting = working || Boolean(message.submissionId);
    }

    return true;
  });

  return { transcript, sending, started, waiting, delivered };
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

const reasoningFree = new WeakMap<ChatMessage, ChatMessage>();

function withoutReasoning(message: ChatMessage) {
  if (message.role !== "assistant" || !Array.isArray(message.content) || !message.content.some(part => part.type === "thinking")) return message;
  let result = reasoningFree.get(message);
  if (!result) reasoningFree.set(message, result = { ...message, content: message.content.filter(part => part.type !== "thinking") } as ChatMessage);
  return result;
}

function invisibleAssistant(message: ChatMessage) {
  const hasToolCall = Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall");

  return message.role === "assistant" && !hasVisibleText(textOf(message.content)) && !hasVisibleText(thinkingOf(message.content)) && message.stopReason !== "aborted" && message.stopReason !== "error" && (hasToolCall || !message.streaming);
}

function repeatedCompletedTool(message: ChatMessage, previous: ChatMessage) {
  return message.role === "tool" && message.toolName !== "spawn_subagents" && (message.toolStatus ?? "done") === "done" && previous.role === "tool" && (previous.toolStatus ?? "done") === "done" && toolTitle(previous) === toolTitle(message);
}

export function finalResponseIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role !== "assistant") continue;

    if (message.stopReason === "aborted" || message.stopReason === "error") return index;

    if (Array.isArray(message.content) && message.content.some(part => part.type === "toolCall")) return -1;

    if (canBranchFrom(message) || textOf(message.content).trim().length > 0) return index;
  }

  return -1;
}

function turnTiming(messages: ChatMessage[], userIndex: number, finalMessage?: ChatMessage) {
  return formatElapsed(userIndex >= 0 ? messages[userIndex].timestamp : messages[0]?.timestamp, finalMessage?.completedAt ?? finalMessage?.timestamp);
}

/** The last message of the turn when it is a failed or stopped response. */
function retryableResponse(messages: ChatMessage[]) {
  const message = messages.at(-1);

  return message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted") ? message : undefined;
}

function MessageList(props: { messages: ChatMessage[]; expanded: boolean; compact?: boolean; debug?: DebugView; showActions?: boolean }) {
  const entries = createMemo<Array<{ message: ChatMessage; count: number }>>(previous => {
    const retained = new Map(previous.map(entry => [entry.message, entry]));

    return compactCompletedTools(props.messages, (props.compact ?? true) && !props.debug?.toolDetails).map(entry => {
      const prior = retained.get(entry.message);

      return prior?.count === entry.count ? prior : entry;
    });
  }, []);

  return <Key each={entries()} by={entry => entry.message.id}>{entry => <Message message={entry().message} toolCount={entry().count} showActions={props.showActions ?? true} expanded={props.expanded} debug={props.debug} />}</Key>;
}

type ConversationTurnProps = { latest?: boolean; messages: ChatMessage[]; promptContexts: PromptContextInfo[]; debug: DebugView; active: boolean; /** A steer message started the next turn, so this turn's work stays open. */ steered?: boolean; retryable: boolean; onRetry: (message: ChatMessage) => Promise<void>; onBranch?: TranscriptActions["onBranch"]; onFork?: TranscriptActions["onFork"]; onForkAndForget?: TranscriptActions["onForkAndForget"]; forkSource?: ForkSource; forkSourceName?: string; onOpenForkSource?: TranscriptActions["onOpenForkSource"]; };

function ConversationTurn(componentProps: ConversationTurnProps) {
  const turnMessages = createMemo(() => componentProps.debug.reasoning ? componentProps.messages : componentProps.messages.map(withoutReasoning));
  const [retryError, setRetryError] = createSignal<string>();
  /** The user's choice wins; without one, the work stays open when a steer cut it. */
  const [workChoice, setWorkOpen] = createSignal<boolean>();
  const workOpen = () => workChoice() ?? componentProps.steered === true;
  const [retrying, setRetrying] = createSignal(false); const retryingRef = createRef(false);
  const userIndex = createMemo(() => (turnMessages().findIndex(isPromptMessage)));
  /** The place of the message this chat branched from. The link to the parent chat shows after it, before later notes such as a compaction. */
  const forkIndex = createMemo(() => { const entryId = componentProps.forkSource?.entryId;

    return entryId ? turnMessages().findIndex(message => (message.entryId ?? message.id) === entryId) : -1; });
  /** A compaction before the final response happened during the turn's work, so it shows in its place in the work. */
  const inWork = (message: ChatMessage, index: number) => message.customType === "compaction" && index < finalIndex();
  const systemMessages = (after: boolean) => turnMessages().filter((message, index) => message.role === "system" && !inWork(message, index) && (forkIndex() >= 0 && index > forkIndex()) === after);
  const renderForkLink = () => <Show when={forkIndex() >= 0 ? componentProps.forkSource : undefined}>{source => <ForkSourceLink source={source()} name={componentProps.forkSourceName} onOpen={componentProps.onOpenForkSource} />}</Show>;

  const finalIndex = createMemo(() => (finalResponseIndex(turnMessages())));
  /** The last point of the chat: the latest final response or compaction. Fork and forget from it would change nothing. */
  const lastPointId = createMemo(() => componentProps.latest ? turnMessages().filter((message, index) => index === finalIndex() || message.customType === "compaction").at(-1)?.id : undefined);
  const forgetFrom = (message: ChatMessage | undefined) => (message?.id === lastPointId() ? undefined : componentProps.onForkAndForget);
  const renderSystemMessages = (after: boolean) => <Key each={systemMessages(after)} by={message => message.id}>{message => <Message message={message()} expanded={false} onFork={canBranchFrom(message()) ? componentProps.onFork : undefined} onBranch={canBranchFrom(message()) ? componentProps.onBranch : undefined} onForkAndForget={canBranchFrom(message()) ? forgetFrom(message()) : undefined} lastPoint={message().id === lastPointId()} />}</Key>;
  const finalThinking = createMemo(() => (finalIndex() >= 0 ? thinkingOf(turnMessages()[finalIndex()].content) : ""));

  const intermediate = createMemo(() => (turnMessages().flatMap((message, index): ChatMessage[] => {
    if (isPromptMessage(message) || isContextInjection(message) || (message.role === "system" && !inWork(message, index))) return [];

    if (index !== finalIndex()) return [message];

    if (!finalThinking()) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;

    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking", thinking: finalThinking() }], stopReason: undefined, errorMessage: undefined }];
  })));

  const userMessages = createMemo(() => (turnMessages().filter(message => isPromptMessage(message) && message.customType !== "piop-subagent-result")));
  /** Subagents whose answers started this turn. They show on the turn's "Worked for" line instead of as a message. */
  const finishedSubagents = createMemo(() => turnMessages().filter(message => isPromptMessage(message) && message.customType === "piop-subagent-result").flatMap(message => subagentRuns(message.details)));
  // A click on a subagent opens its chat and must not open or close the work group around it.
  const renderFinishedSubagents = () => finishedSubagents().length > 0 && <span class="subagent-finished" onClick={event => event.preventDefault()}><SubagentResults runs={finishedSubagents()} /></span>;
  /** The work that the daemon left out of this turn until the user opens it. */
  const deferredWork = createMemo(() => finalIndex() >= 0 ? turnMessages()[finalIndex()].deferredWork : undefined);
  const [workError, setWorkError] = createSignal<string>();
  const hasWork = createMemo(() => ((Boolean(deferredWork()) && (componentProps.debug.reasoning || !deferredWork()!.reasoningOnly)) || intermediate().some((message) => !invisibleAssistant(message))));
  /** An open work group loads its work also when a refresh leaves the work out again. */
  const workLoader = createMemo(() => workOpen() && deferredWork() ? turnMessages()[finalIndex()]?.loadWork : undefined);
  createEffect(() => {
    const load = workLoader();

    if (!load) return;
    untrack(() => { setWorkError(undefined);
    load().catch(reason => setWorkError(reason instanceof Error ? reason.message : String(reason))); });
  });
  const reasoningOnly = createMemo(() => deferredWork() ? deferredWork()!.reasoningOnly : (compactCompletedTools(intermediate()).every(({ message }) => message.role === "assistant" && hasVisibleText(thinkingOf(message.content)) && !hasVisibleText(textOf(message.content)) && message.stopReason !== "error" && message.stopReason !== "aborted")));
  const finalSource = createMemo(() => (finalIndex() >= 0 ? turnMessages()[finalIndex()] : undefined));
  const finalMessage = createMemo(() => (finalIndex() >= 0 ? { ...turnMessages()[finalIndex()], content: textOf(turnMessages()[finalIndex()].content) } : undefined));
  /**
   * The final response shows in one place while the turn runs and after it ends, so the end of the turn does not build it again.
   * While the turn runs, a response is final only while it is the last message of the turn and calls no tool.
   */
  const finalShown = createMemo(() => {
    const index = finalIndex();

    if (index < 0) return false;

    if (!componentProps.active) return true;
    const message = turnMessages()[index];

    const later = turnMessages().slice(index + 1).some(item => !isPromptMessage(item) && !isContextInjection(item));

    return !later && !(Array.isArray(message.content) && message.content.some(part => part.type === "toolCall"));
  });
  /** The work of a running turn: every message but the prompt and the final response. The reasoning of the final response stays here. */
  const activeWork = createMemo(() => turnMessages().flatMap((message, index): ChatMessage[] => {
    if (isPromptMessage(message) || isContextInjection(message)) return [];

    if (!finalShown() || index !== finalIndex()) return [message];

    if (!finalThinking()) return [];
    const { promptContext: _promptContext, ...reasoningMessage } = message;

    return [{ ...reasoningMessage, id: `${message.id}:reasoning`, content: [{ type: "thinking", thinking: finalThinking() }], stopReason: undefined, errorMessage: undefined }];
  }));

  const turnCacheUsage = createMemo(() => (turnMessages().reduce((total, message) => {
    for (const usage of message.role === "assistant" ? [message.usage, message.deferredWork?.usage] : []) if (usage) {
      total.input += usage.input;
      total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite ?? 0;
    }

    return total;
  }, { input: 0, cacheRead: 0, cacheWrite: 0 })));


  const workedFor = createMemo(() => (turnTiming(turnMessages(), userIndex(), finalMessage())));
  /** Pi runs a failed response again from the prompt before it, so a turn without a prompt that has content cannot be retried. */
  const hasRetryPrompt = createMemo(() => turnMessages().some(message => isPromptMessage(message) && (message.role !== "user" || hasVisibleText(textOf(message.content)) || (Array.isArray(message.content) && message.content.some(part => part.type === "image")))));
  const retryTarget = createMemo(() => (componentProps.retryable && hasRetryPrompt() ? retryableResponse(turnMessages()) : undefined));
  const retry = () => {
    const target = retryTarget();

    if (!target || retryingRef.current) return;
    retryingRef.current = true; setRetrying(true); setRetryError(undefined);
    void componentProps.onRetry(target).catch((reason) => setRetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => { retryingRef.current = false; setRetrying(false); });
  };

  const firstResponseInputTokens = createMemo(() => {
    const earlyTokens = componentProps.promptContexts[0]?.inputTokens;

    if (earlyTokens !== undefined) return earlyTokens;
    const response = turnMessages().find(message => message.role === "assistant");

    return cacheHitStats(response?.deferredWork?.firstUsage ?? response?.usage)?.promptTokens;
  });

  const renderPromptContextBar = () => (<Show when={componentProps.debug.contextBar && firstResponseInputTokens()}>{inputTokens => <Index each={componentProps.promptContexts}>{context => <PromptContextBar context={context()} inputTokens={inputTokens()} />}</Index>}</Show>);
  const renderWorkGroup = () => <Show when={hasWork()}><details class="work-group" open={workOpen()} onToggle={(event) => setWorkOpen(event.currentTarget.open)}><summary>{reasoningOnly() ? "Reasoning" : workedFor() ? `Worked for ${workedFor()}` : "Work"}<ChevronRight size={12} class="work-group-chevron" aria-hidden="true" />{renderFinishedSubagents()}</summary>{workOpen() && <div class={`work-group-content${reasoningOnly() ? " reasoning-group-content" : ""}`}>{deferredWork() ? workError() ? <div class="message-failure" role="alert">Could not load this work: {workError()}</div> : <div class="mcp-loading" role="status"><LoaderCircle class="mcp-loading-spinner" size={14} aria-hidden="true" /><span>Loading work</span></div> : <MessageList messages={intermediate()} expanded debug={componentProps.debug} showActions={false} />}</div>}</details></Show>;

  const renderTurnEnd = () => (<>
    <Show when={componentProps.active} fallback={<>
      {renderWorkGroup()}
      <Show when={finalShown() && !hasWork() && finishedSubagents().length === 0}><hr class="turn-divider" /></Show>
    </>}>
      <div class="active-work-content"><MessageList messages={activeWork()} expanded compact={false} debug={componentProps.debug} showActions={false} /></div>
    </Show>
    <Show when={finalShown()}><Message message={required(finalMessage())} turnCacheUsage={turnCacheUsage()} debug={componentProps.debug} showActions={!componentProps.active} onBranch={!componentProps.active && canBranchFrom(finalSource()) ? componentProps.onBranch : undefined} onFork={!componentProps.active && canBranchFrom(finalSource()) ? componentProps.onFork : undefined} onForkAndForget={!componentProps.active && canBranchFrom(finalSource()) ? forgetFrom(finalSource()) : undefined} lastPoint={finalSource()?.id === lastPointId()} retrying={retrying()} onRetry={retryTarget() ? retry : undefined} /></Show>
    <Show when={!componentProps.active} fallback={renderForkLink()}>
      <Show when={retryError()}>{error => <div class="message-failure retry-error" role="alert">Retry failed: {error()}</div>}</Show>
      {renderSystemMessages(false)}
      {renderForkLink()}
      {renderSystemMessages(true)}
    </Show>
  </>);

  return <section class="conversation-turn" classList={{ "latest-turn": componentProps.latest === true }}>
    {<Key each={userMessages()} by={(message) => message.id}>{(message, _index) => <Message  message={message()} debug={componentProps.debug} />}</Key>}
    {(componentProps.active || !hasWork()) && finishedSubagents().length > 0 && <div class="subagent-finished-line">{renderFinishedSubagents()}</div>}
    {renderPromptContextBar()}
    {componentProps.debug.contextInjections && <MessageList messages={turnMessages().filter(isContextInjection)} expanded={false} debug={componentProps.debug} />}
    {renderTurnEnd()}
  </section>;
}
