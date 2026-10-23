import { extendedHooks } from "../hooks-extended/interface.ts";
import type { AgentToolResult, ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BrokerRequestError, currentHost, request } from "./client.ts";
import { createProfileSession } from "./agent-profiles.ts";
import { durableMailbox } from "../piop-storage/durable-mailbox.ts";
import { activeConversation } from "./conversation-location.ts";

const messageSchema = Schema.Object({ role: Schema.String(), content: Schema.Optional(Schema.Unknown()), toolName: Schema.Optional(Schema.String()), customType: Schema.Optional(Schema.String()), details: Schema.Optional(Schema.Unknown()), stopReason: Schema.Optional(Schema.String()), errorMessage: Schema.Optional(Schema.String()) });

const entrySchema = Schema.Object({ id: Schema.String(), name: Schema.Optional(Schema.String()), parentId: Schema.Optional(Schema.Union([Schema.String(), Schema.Null()])), type: Schema.String(), message: Schema.Optional(messageSchema), customType: Schema.Optional(Schema.String()), content: Schema.Optional(Schema.Unknown()), details: Schema.Optional(Schema.Unknown()), timestamp: Schema.Optional(Schema.Union([Schema.String(), Schema.Number()])) });

const stateSchema = Schema.Object({ sessionFile: Schema.Optional(Schema.String()), isPaused: Schema.Optional(Schema.Boolean()), isPausing: Schema.Optional(Schema.Boolean()), isStreaming: Schema.Optional(Schema.Boolean()), isCompacting: Schema.Optional(Schema.Boolean()), pendingMessageCount: Schema.Optional(Schema.Number()) });

const snapshotSchema = Schema.Object({ revision: Schema.String(), stateKey: Schema.Optional(Schema.String()), state: stateSchema, history: Schema.Object({ entries: Schema.Array(entrySchema), leafId: Schema.Optional(Schema.Union([Schema.String(), Schema.Null()])) }) });

const deliverySchema = Schema.Object({ id: Schema.String(), deliveryId: Schema.String({ minLength: 1 }), sourceSessionId: Schema.String(), sourceHostId: Schema.String(), sourceName: Schema.Optional(Schema.String()), message: Schema.String({ minLength: 1 }), wake: Schema.Optional(Schema.Boolean()), deliverAs: Schema.Optional(Schema.Union([Schema.Literal("steer"), Schema.Literal("followUp")])) });

const address = { peerId: Type.String({ minLength: 1 }), hostId: Type.Optional(Type.String({ minLength: 1 })) };

type Target = { peerId: string; hostId?: string; afterCursor?: string };

const parentTypes = new Set(["piop-subagent-parent", "piop-review-parent"]);

function requireRootCaller(ctx: ExtensionContext) {
  if (ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && parentTypes.has(entry.customType))) {
    throw new Error("Subagents and reviewers cannot use peer tools");
  }
}

async function rootSnapshot(sessionId: string, hostId: string, signal?: AbortSignal) {
  const snapshot = await sessionSnapshot(sessionId, hostId, signal);

  if (snapshot.history.entries.some(entry => entry.type === "custom" && parentTypes.has(entry.customType ?? ""))) {
    throw new Error("This is a subagent, not a peer; use the subagent tools for it");
  }

  return snapshot;
}

const result = <T>(data: T): AgentToolResult<T> => ({ content: [{ type: "text", text: JSON.stringify(data) }], details: data });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

const deliveredSchema = Schema.Object({ customType: Schema.Literal("piop-agent-message"), details: Schema.Object({ notificationId: Schema.String() }) });

type Mail = { message: Parameters<ExtensionAPI["sendMessage"]>[0]; notificationId: string };

const mailboxes = new WeakMap<ExtensionAPI, Mail[]>();

const mailboxGenerations = new WeakMap<ExtensionAPI, number>();

const mailboxMessageSchema = Schema.Object({ details: Schema.Object({ notificationId: Schema.String() }) });

function deliverMailbox(pi: ExtensionAPI, mail: Mail[]) {
  for (const [index, item] of mail.entries()) {
    pi.sendMessage(item.message, { triggerTurn: index === mail.length - 1 });
    pi.events.emit("piop:agent-mail", { notificationId: item.notificationId, customType: item.message.customType });
  }
}

/** deliverAs: a busy recipient gets the message in Pi's steering or follow-up queue. Without it, the message waits in the mailbox until the agent settles. */
function queueAgentMailbox(pi: ExtensionAPI, ctx: ExtensionContext, message: Mail["message"], notificationId: string, defer = false, deliverAs?: "steer" | "followUp") {
  const mail = { message, notificationId };

  if (!defer && ctx.isIdle()) { deliverMailbox(pi, [mail]);

    return; }

  if (!defer && deliverAs) {
    pi.sendMessage(message, { triggerTurn: true, deliverAs });
    pi.events.emit("piop:agent-mail", { notificationId, customType: message.customType });

    return; }

  const queued = mailboxes.get(pi) ?? [];
  queued.push(mail);
  mailboxes.set(pi, queued);
  // A message from a peer ends a wait in the running turn, so the turn can finish and the agent reads the message.
  if (!defer && message.customType === "piop-agent-message") pi.events.emit("piop:agent-mail", { notificationId, customType: message.customType });
}

export async function sendAgentMailbox(pi: ExtensionAPI, ctx: ExtensionContext, message: Mail["message"], notificationId: string, deliverAs?: "steer" | "followUp") {
  const generation = mailboxGenerations.get(pi);
  await durableMailbox(pi).send(ctx, message, notificationId, item => {
    if (generation === mailboxGenerations.get(pi)) queueAgentMailbox(pi, ctx, item, notificationId, false, deliverAs);
  });
}

export async function sessionSnapshot(sessionId: string, hostId: string, signal?: AbortSignal) {
  return Parse(snapshotSchema, await request("/orchestration", { action: "read", sessionId, hostId }, signal, 30_000));
}

/** The longest message or task a chat or subagent may get from message_peer, create_peer, message_subagent or spawn_subagents. The tool definitions leave it out. */
export const MAX_MESSAGE_LENGTH = 100_000;

export function requireMessageLength(message: string) {
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`The message is ${message.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`);
}

/** discardOnFailure: the recipient is a new chat that is deleted when the message cannot be delivered. deliverAs: how a busy recipient gets it. */
export async function sendSessionMessage(ctx: ExtensionContext, sessionId: string, hostId: string, message: string, wake: boolean, signal?: AbortSignal, deliveryId: string = randomUUID(), discardOnFailure = false, deliverAs?: "steer" | "followUp") {
  if (sessionId === ctx.sessionManager.getSessionId() && hostId === currentHost()) throw new Error("Choose another conversation as the recipient");
  await activeConversation(sessionId, hostId, signal);

  return request("/orchestration", { action: "send", sessionId, hostId, message, wake, deliveryId, discardOnFailure, deliverAs, sourceSessionId: ctx.sessionManager.getSessionId(), sourceHostId: currentHost(), sourceName: ctx.sessionManager.getSessionName() }, signal, 60_000);
}

function executionStopped(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const { isStreaming, isCompacting, isPausing } = snapshot.state;

  return !isStreaming && !isCompacting && !isPausing;
}

async function interruptionComplete(sessionId: string, hostId: string, retired: boolean, signal?: AbortSignal) {
  if (retired) return true;

  return executionStopped(await sessionSnapshot(sessionId, hostId, signal));
}

export async function interruptSession(sessionId: string, hostId: string, signal?: AbortSignal, deliveryId?: string) {
  const timeout = AbortSignal.timeout(10_000);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let failures = 0;

  while (true) {
    signal?.throwIfAborted();

    try {
      const receipt = await request("/orchestration", { action: "interrupt", sessionId, hostId, deliveryId }, signal, 30_000);
      const completed = Check(Schema.Object({ completed: Schema.Literal(true) }), receipt);

      const retired = Check(Schema.Object({ retired: Schema.Literal(true) }), receipt);

      if (completed && await interruptionComplete(sessionId, hostId, retired, signal)) return receipt;
      failures = 0;
    } catch (error) {
      signal?.throwIfAborted();

      if (!(error instanceof BrokerRequestError) || !error.transient) throw error;
      failures++;
    }

    await delay(250 * 2 ** Math.min(failures, 4) + Math.random() * 250, undefined, { signal });
  }
}

export function branchEntries(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const byId = new Map(snapshot.history.entries.map(entry => [entry.id, entry]));
  const branch: typeof snapshot.history.entries = [];
  const seen = new Set<string>();
  let id = snapshot.history.leafId === undefined ? snapshot.history.entries.at(-1)?.id : snapshot.history.leafId;

  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = byId.get(id);

    if (!entry) break;
    branch.push(entry);
    id = entry.parentId ?? undefined;
  }

  return branch.reverse();
}

function messageText(message: { content?: unknown }) {
  if (Check(Schema.String(), message.content)) return message.content;

  return Array.isArray(message.content) ? message.content.flatMap(part => Check(textSchema, part) ? [part.text] : []).join("\n") : "";
}

export function snapshotStatus(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const state = snapshot.state;

  if (state.isPaused || state.isPausing) return "paused";

  return state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0 ? "running" : "idle";
}

async function poll(target: Target, signal?: AbortSignal) {
  const hostId = target.hostId ?? currentHost();
  const snapshot = await rootSnapshot(target.peerId, hostId, signal);
  const messages = branchEntries(snapshot).filter(entry => entry.type === "message");
  const last = messages.findLast(entry => entry.message?.role === "assistant");
  const status = snapshotStatus(snapshot);
  const message = last?.message;
  const text = message ? messageText(message) : "";
  const cursor = createHash("sha256").update(JSON.stringify([hostId, target.peerId, snapshot.revision, status, last?.id, text])).digest("hex");
  const changed = cursor !== target.afterCursor;
  const name = snapshot.history.entries.findLast(entry => entry.type === "session_info" && entry.name)?.name ?? target.peerId;
  const answer = text || message?.errorMessage || (message ? "(No text in the answer.)" : "(No answer yet.)");

  return { peer: { id: target.peerId, hostId, status }, stateKey: snapshot.stateKey ?? null, name, answer, cursor, changed,
    latestAssistantMessage: changed && last ? { id: last.id, text: text.slice(0, 2000), truncated: text.length > 2000, stopReason: message?.stopReason, error: message?.errorMessage } : undefined };
}

async function deliver(pi: ExtensionAPI, ctx: ExtensionContext, delivery: Static<typeof deliverySchema>) {
  const notificationId = delivery.deliveryId;
  const content = JSON.stringify({ notificationId, sourceSessionId: delivery.sourceSessionId, sourceHostId: delivery.sourceHostId, sourceName: delivery.sourceName, message: delivery.message });
  await sendAgentMailbox(pi, ctx, { customType: "piop-agent-message", content, display: true, details: { notificationId } }, notificationId, delivery.deliverAs);

  return { sessionId: ctx.sessionManager.getSessionId(), accepted: true, notificationId };
}

function readItem(entry: Static<typeof entrySchema>, includeOutputs: boolean, cap: number) {
  const message = entry.message ?? { role: "custom", customType: entry.customType, content: entry.content };
  const text = message.role === "toolResult" && !includeOutputs ? "" : messageText(message);

  return { id: entry.id, role: message.role, toolName: message.toolName, customType: message.customType, text: text.slice(0, cap), truncated: text.length > cap,
    stopReason: message.stopReason, error: message.errorMessage };
}

/**
 * Waits until the state of one of the peers that were read changes after its snapshot, or until waitMs passes. Each
 * watch request returns after at most a few minutes; the caller reads the peers again and waits again.
 */
async function nextChange(polls: Awaited<ReturnType<typeof poll>>[], waitMs: number, signal: AbortSignal) {
  if (!polls.length) { await delay(waitMs, undefined, { signal }); return; }
  const local = new AbortController();
  const round = AbortSignal.any([signal, local.signal]);
  try {
    await Promise.race(polls.map(item => request("/orchestration", { action: "watch", sessionId: item.peer.id, hostId: item.peer.hostId, stateKey: item.stateKey, waitMs }, round, waitMs + 30_000)));
  } finally { local.abort(); }
}

/** all: wake only when every target finished with a new answer or failed; otherwise when any one finished. */
async function waitSnapshot(targets: Target[], signal: AbortSignal | undefined, stop: AbortSignal, all: boolean) {
  const round = signal ? AbortSignal.any([signal, stop]) : stop;
  const settled = await Promise.allSettled(targets.map(target => poll(target, round)));
  signal?.throwIfAborted();
  const polls = settled.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
  const stopped = (reason: unknown) => stop.aborted && reason === stop.reason;
  const errors = settled.flatMap((item, index) => item.status === "rejected" && !stopped(item.reason) ? [{ ...targets[index], error: item.reason instanceof Error ? item.reason.message : String(item.reason) }] : []);

  const finished = polls.filter(item => item.peer.status !== "running" && item.changed);
  const wake = all ? finished.length + errors.length === targets.length && finished.length > 0 : finished.length > 0;

  return { polls, errors, wake };
}

const STATUS_NOTES: Record<string, string> = { paused: " (paused)" };

/** The new answers of the chats that finished, each in a <peer_message> tag with the chat's name on the first line. */
/** What ended a wait besides the peers: a message from the user, a message from another chat, or a subagent result. */
type Interruption = "user" | "mail" | "subagent" | undefined;

function peerAnswers(snapshot: Awaited<ReturnType<typeof waitSnapshot>>, interruption: Interruption) {
  const answers = snapshot.polls.filter(item => item.peer.status !== "running" && item.changed).map(item => {
    const answer = item.answer.length > 16_000 ? item.answer.slice(0, 16_000) + "\n[Answer truncated.]" : item.answer;

    return "<peer_message>\nPeer " + item.name + (STATUS_NOTES[item.peer.status] ?? "") + ":\n" + answer + "\n</peer_message>";
  });
  const errors = snapshot.errors.map(item => "Peer " + item.peerId + ": " + item.error);
  const parts = [...answers, ...errors];

  if (interruption === "user") parts.push("The user sent a new message.");
  if (interruption === "mail") parts.push("A message from a peer arrived.");
  if (interruption === "subagent") parts.push("A subagent result arrived.");

  return parts.length ? parts.join("\n\n") : "No peer finished before the wait ended.";
}

function validateTargets(targets: Target[], ctx: ExtensionContext) {
  const keys = targets.map(target => `${target.hostId ?? currentHost()}\0${target.peerId}`);

  if (new Set(keys).size !== keys.length || keys.includes(`${currentHost()}\0${ctx.sessionManager.getSessionId()}`)) throw new Error("Wait targets must be distinct conversations other than this one");
}

const parentMessageSchema = Schema.Object({ message: Schema.String(), sourceSessionId: Schema.Optional(Schema.String()), sourceName: Schema.Optional(Schema.String()) });

const resultDetailsSchema = Schema.Object({ runs: Schema.Array(Schema.Object({ name: Schema.String(), status: Schema.String(), agent: Schema.Optional(Schema.String()), output: Schema.Optional(Schema.String()) })) });

/** A parent sees each finished subagent's name and answer in a <subagent_response> tag. */
export function subagentResponses(runs: Array<{ name: string; output?: string }>) {
  return runs.map(run => "<subagent_response>\nSubagent " + run.name + ":\n" + (run.output ?? "") + "\n</subagent_response>").join("\n\n");
}

/** The sender and text of a delivered agent message. */
function agentMessage(content: string) {
  try { const value = JSON.parse(content); return Check(parentMessageSchema, value) ? value : undefined; } catch { return undefined; }
}

/** A chat sees a message from another chat in a <peer_message> tag, with the sender's chat name on the first line. */
function peerMessage(value: Static<typeof parentMessageSchema>) {
  return "<peer_message>\nPeer " + (value.sourceName || value.sourceSessionId || "unknown") + ":\n" + value.message + "\n</peer_message>";
}

function registerDelivery(pi: ExtensionAPI) {
  const mailbox = durableMailbox(pi);
  let generation = 0;
  let suspended = false;
  let runSignal: AbortSignal | undefined;
  let runAborted = false;

  const cancel = () => {
    generation++;
    suspended = true;
    mailboxGenerations.set(pi, generation);
    mailbox.reset();
    mailboxes.delete(pi);
  };

  const recover = async (ctx: ExtensionContext, defer = false) => {
    const version = generation;

    try {
      await mailbox.replay(ctx, message => {
        if (version === generation) queueAgentMailbox(pi, ctx, message, message.details.notificationId, defer);
      });
      await mailbox.reconcile(ctx);
    } catch (error) { ctx.ui.notify(`Agent mailbox recovery failed: ${(error instanceof Error ? error.message : String(error))}`, "error"); }
  };

  const flush = (ctx: ExtensionContext) => {
    const queued = mailboxes.get(pi);

    if (suspended || !ctx.isIdle()) return;

    if (!queued?.length) { void recover(ctx);

      return; }

    mailboxes.delete(pi);
    deliverMailbox(pi, queued);
  };

  const unsubscribeCancellation = pi.events.on("piop:cancel-preparation", cancel);
  const reset = () => { cancel(); suspended = false; runSignal = undefined; runAborted = false; };

  pi.on("session_start", async (_event, ctx) => { reset(); await recover(ctx, true); });
  pi.on("session_shutdown", () => { reset(); unsubscribeCancellation(); });
  pi.on("agent_start", (_event, ctx) => {
    suspended = false;
    runSignal = ctx.signal;
    runAborted = false;
  });
  pi.on("agent_end", (event, ctx) => {
    runSignal = ctx.signal ?? runSignal;
    runAborted = event.messages.some(message => message.role === "assistant" && message.stopReason === "aborted");
  });
  pi.on("agent_settled", (_event, ctx) => {
    const aborted = runAborted || runSignal?.aborted;
    runSignal = undefined;
    runAborted = false;

    if (aborted) { cancel();

      return; }

    flush(ctx);
  });
  extendedHooks(pi).on("session_available", (_event, ctx) => flush(ctx));
  pi.events.on("piop:rpc", request => {
    if (request.command !== "session_ready") return;
    if (mailboxes.get(pi)?.length) flush(request.ctx);
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "orchestration_message") return;
    request.ready = (async () => {
      const delivery = Parse(deliverySchema, request.payload);

      if (request.ctx.mode !== "rpc") throw new Error("Agent delivery requires an RPC request");

      return deliver(pi, request.ctx, delivery);
    })();
  });
  pi.on("agent_end", async (_event, ctx) => {
    try { await mailbox.reconcile(ctx); }
    catch (error) { ctx.ui.notify(`Agent mailbox acknowledgement failed: ${(error instanceof Error ? error.message : String(error))}`, "error"); }
  });
  pi.on("context", (event, ctx) => {
    const subagent = ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-subagent-parent");

    return { messages: event.messages.flatMap<ContextEvent["messages"][number]>(message => {
      const delivered = message.role === "user" && Check(deliveredSchema, message);
      const custom = message.role === "custom" && ["piop-agent-message", "piop-subagent-result"].includes(message.customType);

      if (!delivered && !custom) return [message];

      if (Check(mailboxMessageSchema, message)) mailbox.consume(ctx, message.details.notificationId);
      const sent = message.role === "custom" && message.customType === "piop-agent-message" ? agentMessage(messageText(message)) : undefined;

      // A subagent sees only the text its parent wrote; a chat sees a message from another chat as a <peer_message>.
      if (sent) return [{ role: "user", content: [{ type: "text", text: subagent ? sent.message : peerMessage(sent) }], timestamp: message.timestamp }];

      if (message.role === "custom" && message.customType === "piop-subagent-result" && Check(resultDetailsSchema, message.details)) {
        return [{ role: "user", content: [{ type: "text", text: subagentResponses(message.details.runs) }], timestamp: message.timestamp }];
      }

      return [{ role: "user", content: [{ type: "text", text: messageText(message) }], timestamp: message.timestamp }];
    }) };
  });
}

/** How long await_peers waits when the agent gives no timeoutMs. */
const DEFAULT_WAIT_MS = 5 * 60_000;

/** The longest await_peers waits, whatever timeoutMs asks for. The tool definition leaves it out. */
const MAX_WAIT_MS = 6 * 60 * 60_000;

export function registerOrchestration(pi: ExtensionAPI) {
  registerDelivery(pi);
  /** The last answer each wait returned, by waiting chat and target chat. */
  const seenAnswers = new Map<string, string>();
  const revisions = { user: 0, mail: 0, subagent: 0 };
  const inputListeners = new Set<() => void>();
  const newInput = (kind: "user" | "mail" | "subagent") => { revisions[kind]++; for (const listener of inputListeners) listener(); };
  pi.on("input", event => { if (event.source !== "extension") newInput("user"); });
  const unsubscribeMail = pi.events.on("piop:agent-mail", event => newInput(event.customType === "piop-subagent-result" ? "subagent" : "mail"));
  pi.on("session_shutdown", unsubscribeMail);
  pi.registerTool({
    name: "create_peer", label: "Create peer", exposure: "model-only",
    description: "Start a new chat/session with its first message. Pick an agent profile or omit it to use your own. The peer starts with no history and runs on its own.",
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), message: Type.String({ minLength: 1 }), agent: Type.Optional(Type.String({ minLength: 1 })), project: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      requireMessageLength(params.message);
      signal?.throwIfAborted();
      const cwd = params.project === undefined ? ctx.cwd
        : Parse(Schema.Object({ cwd: Schema.String() }), await request("/peer-project", { name: params.project, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }, signal)).cwd;
      const created = await createProfileSession(pi, ctx, params.title, params.agent, cwd);

      const deliveryId = randomUUID();
      try { await sendSessionMessage(ctx, created.peerId, created.hostId, params.message, true, signal, deliveryId, true); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // The sender may have lost the answer; Piop then keeps the peer if the message arrived and removes it otherwise.
        const settled = await request("/orchestration", { action: "settle_first_message", sessionId: created.peerId, hostId: created.hostId, sessionPath: created.sessionPath, deliveryId }, undefined, 180_000)
          .catch(settle => { throw new Error(`The first message of peer ${created.peerId} failed, and Piop could not settle it: ${reason}; ${settle instanceof Error ? settle.message : String(settle)}`); });
        if (Parse(Schema.Object({ arrived: Schema.Boolean() }), settled).arrived !== true) throw new Error(`The peer was not created: ${reason}`);
      }

      return result({ peerId: created.peerId, agent: created.agent });
    },
  });
  pi.registerTool({
    name: "list_peers", label: "List peers", exposure: "model-only", description: "List peers with their IDs, hosts and names.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      requireRootCaller(ctx);

      const chats = await request("/agents", undefined, signal);

      return result(Array.isArray(chats) ? chats.map(chat => ({ peerId: chat.sessionId, hostId: chat.hostId, name: chat.name, project: chat.project, active: chat.active })) : chats);
    },
  });
  pi.registerTool({
    name: "branchoff_peer", label: "Branch off peer", exposure: "model-only",
    description: "Start a chat/session in a new worktree, branched off from last commit here. It keeps your agent and your history through your last finished answer, then gets message.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      requireMessageLength(params.message);
      const created = Parse(Schema.Object({ peerId: Schema.String() }), await request("/orchestration", { action: "branch_off", sessionId: ctx.sessionManager.getSessionId(), hostId: currentHost(),
        message: params.message, wake: true, deliveryId: randomUUID(), sourceSessionId: ctx.sessionManager.getSessionId(), sourceHostId: currentHost(), sourceName: ctx.sessionManager.getSessionName() }, signal, 180_000));

      return result({ peerId: created.peerId });
    },
  });
  pi.registerTool({
    name: "message_peer", label: "Message peer", exposure: "model-only", description: "Send a message to a peer. An idle peer starts at once; a busy one reads it after its current work. Returns when the message is accepted.",
    parameters: Type.Object({ ...address, message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      requireMessageLength(params.message);
      const hostId = params.hostId ?? currentHost();
      await rootSnapshot(params.peerId, hostId, signal);

      return result(await sendSessionMessage(ctx, params.peerId, hostId, params.message, true, signal));
    },
  });
  pi.registerTool({
    name: "stop_peer", label: "Stop peer", exposure: "model-only", description: "Stop a peer's current work. It keeps its history and can get new messages. Stop a peer only when the user asked you to.",
    parameters: Type.Object({ ...address }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      const hostId = params.hostId ?? currentHost();

      if (params.peerId === ctx.sessionManager.getSessionId() && hostId === currentHost()) throw new Error("Choose another peer to stop");
      await rootSnapshot(params.peerId, hostId, signal);

      return result(await interruptSession(params.peerId, hostId, signal));
    },
  });
  pi.registerTool({
    name: "read_peer", label: "Read peer", exposure: "model-only", description: "Read the last messages of a peer. To read older messages, pass nextCursor as cursor. includeOutputs adds tool outputs.",
    parameters: Type.Object({ ...address, cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), includeOutputs: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      const snapshot = await rootSnapshot(params.peerId, params.hostId ?? currentHost(), signal);
      const entries = branchEntries(snapshot).filter(entry => entry.type === "message" || entry.type === "custom_message");
      const end = params.cursor ? entries.findIndex(entry => entry.id === params.cursor) : entries.length;

      if (end < 0) throw new Error("Cursor is no longer on the current branch; read again without a cursor");
      const start = Math.max(0, end - (params.limit ?? 20));
      const cap = 4000;
      const items = entries.slice(start, end).map(entry => readItem(entry, params.includeOutputs ?? false, cap));

      return result({ peerId: params.peerId, hostId: params.hostId ?? currentHost(), status: snapshotStatus(snapshot), items, nextCursor: start ? entries[start].id : null });
    },
  });
  pi.registerTool({
    name: "await_peers", label: "Await peers", exposure: "model-only", description: "Wait until any or all of the given peers finish their work. Returns the new answers of the peers that finished.",
    parameters: Type.Object({ targets: Type.Array(Type.Object(address), { minItems: 1 }), for: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])), timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      validateTargets(params.targets, ctx);
      const key = (target: Target) => [ctx.sessionManager.getSessionId(), target.hostId ?? currentHost(), target.peerId].join("\0");
      const targets = params.targets.map(target => ({ ...target, afterCursor: seenAnswers.get(key(target)) }));
      const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
      const deadline = Date.now() + timeoutMs;
      const start = { ...revisions };
      const stop = new AbortController();
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => stop.abort(new Error("Wait timed out")), deadline - Date.now());
      const onInput = () => stop.abort(new Error("Wait interrupted by new input"));
      inputListeners.add(onInput);

      const finish = (snapshot: Awaited<ReturnType<typeof waitSnapshot>>) => {
        // Mail also waits as a pending message, so pending messages count as the user's only when no mail came.
        const mail = revisions.mail !== start.mail; const subagent = revisions.subagent !== start.subagent;
        const interruption: Interruption = revisions.user !== start.user || (!mail && !subagent && ctx.hasPendingMessages()) ? "user" : mail ? "mail" : subagent ? "subagent" : undefined;
        const interrupted = interruption !== undefined;
        // With for: "all", a peer that cannot be read counts as done, so the wait still ends when the others finish.
        const failed = params.for === "all" ? snapshot.errors.length === params.targets.length : snapshot.errors.length > 0;
        const actionable = Boolean(snapshot.wake || failed || interrupted);

        if (!actionable && !stop.signal.aborted && Date.now() < deadline) return undefined;

        // An answer returned once is not returned again by a later wait.
        for (const item of snapshot.polls) if (item.peer.status !== "running" && item.changed) seenAnswers.set(key({ peerId: item.peer.id, hostId: item.peer.hostId }), item.cursor);

        return { content: [{ type: "text" as const, text: peerAnswers(snapshot, interruption) }], details: { interrupted, ...snapshot } };
      };

      try {
        while (true) {
          signal?.throwIfAborted();
          const snapshot = await waitSnapshot(targets, signal, stop.signal, params.for === "all");
          const done = finish(snapshot);

          if (done) return done;

          try { await nextChange(snapshot.polls, Math.max(0, deadline - Date.now()), signal ? AbortSignal.any([signal, stop.signal]) : stop.signal); }
          catch (error) {
            signal?.throwIfAborted();

            if (!stop.signal.aborted) throw error;

            return finish(snapshot)!;
          }
        }
      } finally {
        clearTimeout(timer);
        inputListeners.delete(onInput);
      }
    },
  });
}

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agent-mail", handler: (event: { notificationId: string; customType?: string }) => void): () => void;
    emit(channel: "piop:agent-mail", event: { notificationId: string; customType?: string }): void;
  }
}
