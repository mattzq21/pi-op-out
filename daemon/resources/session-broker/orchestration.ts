import { extendedHooks } from "../hooks-extended/interface.ts";
import type { AgentToolResult, ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BrokerRequestError, currentHost, request } from "./client.ts";
import { createProfileSession } from "./agent-profiles.ts";
import { durableMailbox } from "../piop-storage/durable-mailbox.ts";
import { activeConversation } from "./conversation-location.ts";
import { AUXILIARY_PARENT, auxiliaryParent, isAuxiliary } from "../piop-storage/session-records.cjs";
import { sessionName } from "./session-names.cjs";
import { steering } from "./steering.ts";

const messageSchema = Type.Object({ role: Type.String(), content: Type.Optional(Type.Unknown()), toolName: Type.Optional(Type.String()), customType: Type.Optional(Type.String()), details: Type.Optional(Type.Unknown()), stopReason: Type.Optional(Type.String()), errorMessage: Type.Optional(Type.String()) });

const entrySchema = Type.Object({ id: Type.String(), parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])), type: Type.String(), message: Type.Optional(messageSchema), customType: Type.Optional(Type.String()), content: Type.Optional(Type.Unknown()), details: Type.Optional(Type.Unknown()), timestamp: Type.Optional(Type.Union([Type.String(), Type.Number()])) });

const stateSchema = Type.Object({ sessionFile: Type.Optional(Type.String()), sessionName: Type.Optional(Type.String()), isStreaming: Type.Optional(Type.Boolean()), isCompacting: Type.Optional(Type.Boolean()), pendingMessageCount: Type.Optional(Type.Number()) });

const snapshotSchema = Type.Object({ revision: Type.String(), stateKey: Type.Optional(Type.String()), state: stateSchema, history: Type.Object({ entries: Type.Array(entrySchema), leafId: Type.Optional(Type.Union([Type.String(), Type.Null()])) }) });

const deliverySchema = Type.Object({ id: Type.String(), deliveryId: Type.String({ minLength: 1 }), sourceSessionId: Type.String(), sourceHostId: Type.String(), sourceName: Type.Optional(Type.String()), message: Type.String({ minLength: 1 }), wake: Type.Optional(Type.Boolean()), deliverAs: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])) });

const address = { peerId: Type.String({ minLength: 1 }) };

type Target = { peerId: string; afterCursor?: string };


function ownName(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();

  return file ? sessionName(file, ctx.sessionManager.getSessionId()) : undefined;
}

function requireRootCaller(ctx: ExtensionContext) {
  if (isAuxiliary(ctx.sessionManager.getEntries())) throw new Error("Auxiliary chats, such as subagents and reviewers, cannot use peer tools");
}

async function rootSnapshot(sessionId: string, hostId: string, signal?: AbortSignal) {
  const snapshot = await sessionSnapshot(sessionId, hostId, signal);

  if (snapshot.history.entries.some(entry => entry.type === "custom" && entry.customType === AUXILIARY_PARENT)) {
    throw new Error("This is an auxiliary chat, such as a subagent, not a peer");
  }

  return snapshot;
}

const result = <T>(data: T): AgentToolResult<T> => ({ content: [{ type: "text", text: JSON.stringify(data) }], details: data });

const textSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });

const deliveredSchema = Type.Object({ customType: Type.Literal("piop-agent-message"), details: Type.Object({ notificationId: Type.String() }) });

type Mail = { message: Parameters<ExtensionAPI["sendMessage"]>[0]; notificationId: string };

const mailboxes = new WeakMap<ExtensionAPI, Mail[]>();

const mailboxGenerations = new WeakMap<ExtensionAPI, number>();

const mailboxMessageSchema = Type.Object({ details: Type.Object({ notificationId: Type.String() }) });

function deliverMailbox(pi: ExtensionAPI, mail: Mail[]) {
  for (const [index, item] of mail.entries()) {
    pi.sendMessage(item.message, { triggerTurn: index === mail.length - 1 });
    pi.events.emit("piop:agent-mail", { notificationId: item.notificationId, customType: item.message.customType });
  }
}

function queueAgentMailbox(pi: ExtensionAPI, ctx: ExtensionContext, message: Mail["message"], notificationId: string, defer = false, deliverAs?: "steer" | "followUp") {
  const mail = { message, notificationId };

  if (!defer && ctx.isIdle()) { deliverMailbox(pi, [mail]);

    return; }

  if (!defer && deliverAs) {
    pi.sendMessage(message, { triggerTurn: true, deliverAs });

    if (deliverAs === "steer") steering(pi).peerSteered();

    return; }

  const queued = mailboxes.get(pi) ?? [];
  queued.push(mail);
  mailboxes.set(pi, queued);
}

export async function sendAgentMailbox(pi: ExtensionAPI, ctx: ExtensionContext, message: Mail["message"], notificationId: string, deliverAs?: "steer" | "followUp") {
  const generation = mailboxGenerations.get(pi);
  await durableMailbox(pi).send(ctx, message, notificationId, item => {
    if (generation !== mailboxGenerations.get(pi)) return false;
    queueAgentMailbox(pi, ctx, item, notificationId, false, deliverAs);

    return true;
  });
}

export async function sessionSnapshot(sessionId: string, hostId: string, signal?: AbortSignal) {
  return Parse(snapshotSchema, await request("/orchestration", { action: "read", sessionId, hostId }, signal, 30_000));
}

const WATCH_MS = 5 * 60_000;

// Waits until the chat's state differs from stateKey (the stateKey of a snapshot), or a while has passed.
export async function watchSession(sessionId: string, hostId: string, stateKey: string | null, signal?: AbortSignal) {
  await request("/orchestration", { action: "watch", sessionId, hostId, stateKey, waitMs: WATCH_MS }, signal, WATCH_MS + 30_000);
}

export const MAX_MESSAGE_LENGTH = 100_000;

export function requireMessageLength(message: string) {
  if (!message) throw new Error("The message is empty");
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`The message is ${message.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`);
}

export async function sendAgentMailboxes(pi: ExtensionAPI, ctx: ExtensionContext, mail: Mail[]) {
  const generation = mailboxGenerations.get(pi);
  const accepted: Mail[] = [];

  try {
    for (const { message, notificationId } of mail) {
      await durableMailbox(pi).send(ctx, message, notificationId, item => {
        if (generation !== mailboxGenerations.get(pi)) return false;
        accepted.push({ message: item, notificationId });

        return true;
      });
    }
  } finally {
    if (accepted.length && generation === mailboxGenerations.get(pi)) {
      if (ctx.isIdle()) deliverMailbox(pi, accepted);
      else mailboxes.set(pi, [...mailboxes.get(pi) ?? [], ...accepted]);
    }
  }
}

export async function sendSessionMessage(ctx: ExtensionContext, sessionId: string, hostId: string, message: string, wake: boolean, signal?: AbortSignal, deliveryId: string = randomUUID(), discardOnFailure = false, deliverAs?: "steer" | "followUp") {
  if (sessionId === ctx.sessionManager.getSessionId() && hostId === currentHost()) throw new Error("Choose another conversation as the recipient");
  await activeConversation(sessionId, hostId, signal);

  return request("/orchestration", { action: "send", sessionId, hostId, message, wake, deliveryId, discardOnFailure, deliverAs, sourceName: ownName(ctx) }, signal, 60_000);
}

function executionStopped(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const { isStreaming, isCompacting } = snapshot.state;

  return !isStreaming && !isCompacting;
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
      const completed = Check(Type.Object({ completed: Type.Literal(true) }), receipt);

      const retired = Check(Type.Object({ retired: Type.Literal(true) }), receipt);

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
  if (Check(Type.String(), message.content)) return message.content;

  return Array.isArray(message.content) ? message.content.flatMap(part => Check(textSchema, part) ? [part.text] : []).join("\n") : "";
}

export function snapshotStatus(snapshot: Awaited<ReturnType<typeof sessionSnapshot>>) {
  const state = snapshot.state;

  return state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0 ? "running" : "idle";
}

async function poll(target: Target, signal?: AbortSignal) {
  const hostId = currentHost();
  const snapshot = await rootSnapshot(target.peerId, hostId, signal);
  const messages = branchEntries(snapshot).filter(entry => entry.type === "message");
  const last = messages.findLast(entry => entry.message?.role === "assistant");
  const status = snapshotStatus(snapshot);
  const message = last?.message;
  const text = message ? messageText(message) : "";
  const cursor = createHash("sha256").update(JSON.stringify([hostId, target.peerId, snapshot.revision, status, last?.id, text])).digest("hex");
  const changed = cursor !== target.afterCursor;
  const name = snapshot.state.sessionName ?? target.peerId;
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

async function nextChange(polls: Awaited<ReturnType<typeof poll>>[], waitMs: number, signal: AbortSignal) {
  if (!polls.length) { await delay(waitMs, undefined, { signal }); return; }
  const local = new AbortController();
  const round = AbortSignal.any([signal, local.signal]);
  try {
    await Promise.race(polls.map(item => request("/orchestration", { action: "watch", sessionId: item.peer.id, hostId: item.peer.hostId, stateKey: item.stateKey, waitMs }, round, waitMs + 30_000)));
  } finally { local.abort(); }
}

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

type Interruption = "user" | "peer" | "subagent" | undefined;

function peerAnswers(snapshot: Awaited<ReturnType<typeof waitSnapshot>>, interruption: Interruption) {
  const answers = snapshot.polls.filter(item => item.peer.status !== "running" && item.changed).map(item => {
    const answer = item.answer.length > 16_000 ? item.answer.slice(0, 16_000) + "\n[Answer truncated.]" : item.answer;

    return "<peer_message>\nPeer " + item.name + ":\n" + answer + "\n</peer_message>";
  });
  const errors = snapshot.errors.map(item => "Peer " + item.peerId + ": " + item.error);
  const parts = [...answers, ...errors];

  if (interruption === "user") parts.push("The user sent a steer message.");
  if (interruption === "peer") parts.push("A peer sent a steer message.");
  if (interruption === "subagent") parts.push("A subagent result arrived. Call await_subagents to get it.");

  return parts.length ? parts.join("\n\n") : "No peer finished before the wait ended.";
}

function validateTargets(targets: Target[], ctx: ExtensionContext) {
  const ids = targets.map(target => target.peerId);

  if (new Set(ids).size !== ids.length || ids.includes(ctx.sessionManager.getSessionId())) throw new Error("Wait targets must be distinct conversations other than this one");
}

const parentMessageSchema = Type.Object({ message: Type.String(), sourceSessionId: Type.Optional(Type.String()), sourceName: Type.Optional(Type.String()) });

const resultDetailsSchema = Type.Object({ runs: Type.Array(Type.Object({ name: Type.String(), status: Type.String(), agent: Type.Optional(Type.String()), output: Type.Optional(Type.String()) })) });

export function subagentResponses(runs: Array<{ name: string; output?: string }>) {
  return runs.map(run => "<subagent_response>\nSubagent " + run.name + ":\n" + (run.output ?? "") + "\n</subagent_response>").join("\n\n");
}

function agentMessage(content: string) {
  try { const value = JSON.parse(content); return Check(parentMessageSchema, value) ? value : undefined; } catch { return undefined; }
}

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
    if (!ctx.sessionManager.getSessionFile()) return;
    const version = generation;

    try {
      await mailbox.replay(ctx, message => {
        if (version !== generation) return false;
        queueAgentMailbox(pi, ctx, message, message.details.notificationId, defer);

        return true;
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
    const auxiliary = auxiliaryParent(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId()) !== undefined;

    return { messages: event.messages.flatMap<ContextEvent["messages"][number]>(message => {
      const delivered = message.role === "user" && Check(deliveredSchema, message);
      const custom = message.role === "custom" && ["piop-agent-message", "piop-subagent-result"].includes(message.customType);

      if (!delivered && !custom) return [message];

      if (Check(mailboxMessageSchema, message)) mailbox.consume(ctx, message.details.notificationId);
      const sent = message.role === "custom" && message.customType === "piop-agent-message" ? agentMessage(messageText(message)) : undefined;

      if (sent) return [{ role: "user", content: [{ type: "text", text: auxiliary ? sent.message : peerMessage(sent) }], timestamp: message.timestamp }];

      if (message.role === "custom" && message.customType === "piop-subagent-result" && Check(resultDetailsSchema, message.details)) {
        return [{ role: "user", content: [{ type: "text", text: subagentResponses(message.details.runs) }], timestamp: message.timestamp }];
      }

      return [{ role: "user", content: [{ type: "text", text: messageText(message) }], timestamp: message.timestamp }];
    }) };
  });
}

const DEFAULT_WAIT_MS = 5 * 60_000;

const MAX_WAIT_MS = 6 * 60 * 60_000;

export function registerOrchestration(pi: ExtensionAPI) {
  registerDelivery(pi);
  const seenAnswers = new Map<string, string>();
  const revisions = { user: 0, peer: 0, subagent: 0 };
  const inputListeners = new Set<() => void>();
  const newInput = (kind: "user" | "peer" | "subagent") => { revisions[kind]++; for (const listener of inputListeners) listener(); };
  const steer = steering(pi);
  steer.onSteer(source => newInput(source));
  const unsubscribeMail = pi.events.on("piop:agent-mail", event => { if (event.customType === "piop-subagent-result") newInput("subagent"); });
  pi.on("session_shutdown", unsubscribeMail);
  pi.registerTool({
    name: "create_peer", label: "Create peer", exposure: "model-only",
    description: "Start a new chat/session with its first message. Pick an agent profile or omit it to use your own. The peer starts with no history and runs on its own.",
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), message: Type.String(), agent: Type.Optional(Type.String({ minLength: 1 })), project: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      requireMessageLength(params.message);
      signal?.throwIfAborted();
      const cwd = params.project === undefined ? ctx.cwd
        : Parse(Type.Object({ cwd: Type.String() }), await request("/peer-project", { name: params.project, cwd: ctx.cwd }, signal)).cwd;
      const created = await createProfileSession(pi, ctx, params.title, params.agent, cwd);

      const deliveryId = randomUUID();
      try { await sendSessionMessage(ctx, created.peerId, created.hostId, params.message, true, signal, deliveryId, true); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const settled = await request("/orchestration", { action: "settle_first_message", sessionId: created.peerId, hostId: created.hostId, sessionPath: created.sessionPath, deliveryId }, undefined, 180_000)
          .catch(settle => { throw new Error(`The first message of peer ${created.peerId} failed, and Piop could not settle it: ${reason}; ${settle instanceof Error ? settle.message : String(settle)}`); });
        if (Parse(Type.Object({ arrived: Type.Boolean() }), settled).arrived !== true) throw new Error(`The peer was not created: ${reason}`);
      }

      return result({ peerId: created.peerId, agent: created.agent });
    },
  });
  pi.registerTool({
    name: "list_peers", label: "List peers", exposure: "model-only", description: "List peers with their IDs and names.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      requireRootCaller(ctx);

      const chats = await request("/agents", undefined, signal);

      return result(Array.isArray(chats) ? chats.map(chat => ({ peerId: chat.sessionId, name: chat.name, project: chat.project, active: chat.active })) : chats);
    },
  });
  pi.registerTool({
    name: "branchoff_peer", label: "Branch off peer", exposure: "model-only",
    description: "Start a chat/session in a new worktree, branched off from last commit here. It keeps your agent and your history through your last finished answer, then gets message.",
    parameters: Type.Object({ message: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      requireMessageLength(params.message);
      const created = Parse(Type.Object({ peerId: Type.String() }), await request("/orchestration", { action: "branch_off", sessionId: ctx.sessionManager.getSessionId(), hostId: currentHost(),
        message: params.message, wake: true, deliveryId: randomUUID(), sourceName: ownName(ctx) }, signal, 180_000));

      return result({ peerId: created.peerId });
    },
  });
  pi.registerTool({
    name: "message_peer", label: "Message peer", exposure: "model-only", description: "Send a message to a peer. An idle peer starts at once. A busy one reads it after its current work, or during it with delivery: \"steer\". Returns when the message is accepted.",
    parameters: Type.Object({ ...address, message: Type.String(), delivery: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("steer")])) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      requireMessageLength(params.message);
      await rootSnapshot(params.peerId, currentHost(), signal);

      return result(await sendSessionMessage(ctx, params.peerId, currentHost(), params.message, true, signal, undefined, false, params.delivery === "steer" ? "steer" : undefined));
    },
  });
  pi.registerTool({
    name: "stop_peer", label: "Stop peer", exposure: "model-only", description: "Stop a peer's current work. It keeps its history and can get new messages. Stop a peer only when the user asked you to.",
    parameters: Type.Object({ ...address }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);

      if (params.peerId === ctx.sessionManager.getSessionId()) throw new Error("Choose another peer to stop");
      await rootSnapshot(params.peerId, currentHost(), signal);

      return result(await interruptSession(params.peerId, currentHost(), signal));
    },
  });
  pi.registerTool({
    name: "read_peer", label: "Read peer", exposure: "model-only", description: "Read the last messages of a peer. To read older messages, pass nextCursor as cursor. includeOutputs adds tool outputs.",
    parameters: Type.Object({ ...address, cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), includeOutputs: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      const snapshot = await rootSnapshot(params.peerId, currentHost(), signal);
      const entries = branchEntries(snapshot).filter(entry => entry.type === "message" || entry.type === "custom_message");
      const end = params.cursor ? entries.findIndex(entry => entry.id === params.cursor) : entries.length;

      if (end < 0) throw new Error("Cursor is no longer on the current branch; read again without a cursor");
      const start = Math.max(0, end - (params.limit ?? 20));
      const cap = 4000;
      const items = entries.slice(start, end).map(entry => readItem(entry, params.includeOutputs ?? false, cap));

      return result({ peerId: params.peerId, status: snapshotStatus(snapshot), items, nextCursor: start ? entries[start].id : null });
    },
  });
  pi.registerTool({
    name: "await_peers", label: "Await peers", exposure: "model-only", description: "Wait until any or all of the given peers finish their work. Returns the new answers of the peers that finished.",
    parameters: Type.Object({ targets: Type.Array(Type.Object(address), { minItems: 1 }), for: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])), timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, params, signal, _update, ctx) {
      requireRootCaller(ctx);
      validateTargets(params.targets, ctx);
      const key = (target: Target) => [ctx.sessionManager.getSessionId(), target.peerId].join("\0");
      const targets = params.targets.map(target => ({ ...target, afterCursor: seenAnswers.get(key(target)) }));
      const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
      const deadline = Date.now() + timeoutMs;
      const start = { ...revisions };
      const stop = new AbortController();
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => stop.abort(new Error("Wait timed out")), deadline - Date.now());
      const onInput = () => stop.abort(new Error("Wait interrupted by new input"));
      inputListeners.add(onInput);

      const finish = (snapshot: Awaited<ReturnType<typeof waitSnapshot>>) => {
        const peer = revisions.peer !== start.peer; const subagent = revisions.subagent !== start.subagent;
        const interruption: Interruption = revisions.user !== start.user || (!peer && !subagent && steer.waiting()) ? "user" : peer ? "peer" : subagent ? "subagent" : undefined;
        const interrupted = interruption !== undefined;
        const failed = params.for === "all" ? snapshot.errors.length === params.targets.length : snapshot.errors.length > 0;
        const actionable = Boolean(snapshot.wake || failed || interrupted);

        if (!actionable && !stop.signal.aborted && Date.now() < deadline) return undefined;

        for (const item of snapshot.polls) if (item.peer.status !== "running" && item.changed) seenAnswers.set(key({ peerId: item.peer.id }), item.cursor);

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
