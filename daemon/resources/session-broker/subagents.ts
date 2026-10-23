import { reserveSessionId } from "../piop-storage/session-file.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, CustomEntryDraft } from "@earendil-works/pi-coding-agent";
import type { SubagentLimitsRequest } from "../../../extensions/piop-define-agents/contracts.ts";
import { Type } from "@earendil-works/pi-ai";
import { Parse } from "typebox/value";
import { agentProfilesTool, resolveAgentProfile, SUBAGENT_TOOLS, PEER_TOOLS } from "./agent-profiles.ts";
import { childFastModeEntry } from "./fast-mode.ts";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { currentHost } from "./client.ts";
import { writeSessionFile } from "../piop-storage/session-file.ts";
import { activeConversation } from "./conversation-location.ts";
import { interruptSession, requireMessageLength, sendSessionMessage, sessionSnapshot, snapshotStatus, subagentResponses } from "./orchestration.ts";
import { SUBAGENT_PARENT, latestRuns, ownedRuns, saveRun, subagentParent, subagentPayload, registerSubagentResults, type SubagentRun } from "./subagent-state.ts";
import { acceptedSubmission, cancelSubagent, finishRun, observeSubagent, subagentReceiptSchema, SubagentCancellation, type ActiveSubagent } from "./subagent-reconciliation.ts";
import { savedSubagentRuns } from "../piop-storage/subagent-results.ts";

/** A subagent nickname: 1–8 characters, an upper case letter first, then lower case letters or digits. */
const NICKNAME = "^[A-Z][a-z0-9]{0,7}$";

const MAX_DELEGATION_DEPTH = 2;

/** Whether folder is inside a Git work tree. */
function inGitRepository(folder: string) {
  try { return execFileSync("git", ["-C", folder, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() === "true"; }
  catch { return false; }
}

interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; availableTools?: string[] }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

function subagentLimits(pi: ExtensionAPI, ctx: ExtensionContext) {
  const limits: SubagentLimitsRequest = {};
  pi.events.emit("piop:agents:subagent-limits", limits);
  const parent = subagentParent(ctx);

  return { max_subagents: Math.min(limits.max_subagents ?? 8, parent?.max_subagents ?? Number.MAX_SAFE_INTEGER), max_sub_subagents: limits.max_sub_subagents ?? 8 };
}

function requireSubagentSlots(pi: ExtensionAPI, ctx: ExtensionContext, occupied: number, requested: number) {
  const limit = subagentLimits(pi, ctx).max_subagents;

  if (occupied + requested > limit) throw new Error(`This agent allows at most ${limit} concurrent subagents; ${occupied} slots are occupied`);
}

function delegationScope(ctx: ExtensionContext) {
  const parent = subagentParent(ctx);

  return { depth: parent ? parent.depth ?? 1 : 0, taskPath: parent ? parent.taskPath ?? `/root/${ctx.sessionManager.getSessionId()}` : "/root" };
}

function requireDelegation(ctx: ExtensionContext) {
  const scope = delegationScope(ctx);

  if (scope.depth >= MAX_DELEGATION_DEPTH) throw new Error("Delegation is limited to two levels: root → child → grandchild. Return your findings to the parent.");

  return scope;
}

type SubagentTask = { task: string; name: string; agent?: string; sessionId?: string };

function resumeSubagent(runs: SubagentRun[], parentSessionId: string, task: SubagentTask, toolCallId: string): SubagentRun {
  if (task.agent) throw new Error("A resumed subagent keeps its original agent profile");
  const previous = runs.find(run => run.parentSessionId === parentSessionId && run.sessionId === task.sessionId && run.hostId === currentHost() && run.sessionPath);

  if (!previous) throw new Error("Only a child created by this conversation can be resumed");

  return { version: 1, toolCallId, parentSessionId, sessionId: previous.sessionId, sessionPath: previous.sessionPath, hostId: previous.hostId,
    name: task.name, task: task.task, status: "running", startedAt: Date.now(), runId: randomUUID(), generation: (previous.generation ?? 0) + 1, submission: "prepared",
    agent: previous.agent, taskPath: previous.taskPath, cwd: previous.cwd };
}

async function createSubagent(pi: ExtensionAPI, ctx: ExtensionContext, task: SubagentTask, toolCallId: string, signal?: AbortSignal): Promise<SubagentRun> {
  const scope = requireDelegation(ctx);
  const parentSessionId = ctx.sessionManager.getSessionId();
  const runs = latestRuns(ctx);

  if (task.sessionId) {
    const resumed = resumeSubagent(runs, parentSessionId, task, toolCallId);
    const location = await activeConversation(resumed.sessionId, resumed.hostId, signal);

    return { ...resumed, sessionPath: location.sessionPath, cwd: location.cwd };
  }

  const header = ctx.sessionManager.getHeader();

  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before delegating work");
  const profile = await resolveAgentProfile(pi, "subagent", task.agent);
  const fastMode = await childFastModeEntry(pi, profile, Boolean(task.agent));
  const sessionId = await reserveSessionId();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const workspace = { cwd: ctx.cwd };
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId, sessionId, sessionPath, hostId: currentHost(), name: task.name, task: task.task, taskPath: `${scope.taskPath}/${task.name}`, agent: profile.active, status: "running", startedAt: Date.now(), runId: randomUUID(), submission: "prepared", ...workspace };
  let parentId: string | null = null;

  const entry = (value: CustomEntryDraft | { type: "session_info"; name: string }) => { const id = randomUUID(); const result = { ...value, id, parentId, timestamp }; parentId = id;

  return result; };

  try { await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: workspace.cwd },
    entry({ type: "session_info", name: `Subagent: ${task.name}` }),
    entry({ type: "custom", customType: SUBAGENT_PARENT, data: { version: 1, sessionId, hostId: currentHost(), parentSessionId, parentHostId: currentHost(), parentSessionPath: ctx.sessionManager.getSessionFile(), toolCallId, task: task.task, depth: scope.depth + 1, taskPath: run.taskPath, parentTaskPath: scope.taskPath, max_subagents: subagentLimits(pi, ctx).max_sub_subagents } }),
    entry({ type: "custom", customType: "pi-define-agents-state", data: profile }),
    ...fastMode ? [entry(fastMode)] : [],
  ], { dependencies: { workspace: { path: workspace.cwd, kind: "existing" } } }); }
  catch (error) { throw new Error(`Subagent session creation failed in ${workspace.cwd}; chat assets are retained: ${(error instanceof Error ? error.message : String(error))}`, { cause: error }); }

  return run;
}

async function deliverFollowup(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun, lifecycle: ActiveSubagent, message: string, deliverAs: "steer" | "followUp", signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  lifecycle.controller.signal.throwIfAborted();
  signal?.throwIfAborted();

  if (lifecycle.pendingDeliveries) throw new Error("Wait for this child's outstanding message delivery before sending another task");
  if ((lifecycle.run ?? run).submission === "submitted") throw new Error("Wait for this child's saved task to be accepted before sending another task");
  lifecycle.revision++;
  lifecycle.pendingDeliveries++;
  const deliveryId = randomUUID();
  lifecycle.deliveryIds.add(deliveryId);
  const observed = lifecycle.run ?? run;
  observed.deliveryIds = [...lifecycle.deliveryIds];
  observed.task = message;
  observed.taskStartedAt = Date.now();
  observed.activeMs = 0;
  observed.submission = "submitted";
  observed.taskNotificationId = undefined;
  saveRun(pi, ctx, observed);

  try {
    const data = await sendSessionMessage(ctx, run.sessionId, run.hostId, message, true, signal, deliveryId, false, deliverAs);
    acceptedSubmission(observed, Parse(subagentReceiptSchema, data));
    saveRun(pi, ctx, observed);

    return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  } finally { lifecycle.revision++; lifecycle.pendingDeliveries--; }
}

type SubagentExecution = { pi: ExtensionAPI; ctx: ExtensionContext; toolCallId: string; active: Map<string, ActiveSubagent>; results: SubagentRun[]; signal?: AbortSignal; ready: () => void; publish: (run: SubagentRun) => void };

async function executeSubagent(task: SubagentTask, execution: SubagentExecution) {
  const { pi, ctx, toolCallId, active, results, publish } = execution;
  const controller = new AbortController();
  const signal = execution.signal ? AbortSignal.any([execution.signal, controller.signal]) : controller.signal;
  let finished = () => {};

  let started = () => {};

  const done = new Promise<void>(resolve => { finished = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const lifecycle: ActiveSubagent = { controller, done, ready, started, closing: false, revision: 0, pendingDeliveries: 0, deliveryIds: new Set() };
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId: ctx.sessionManager.getSessionId(), sessionId: task.sessionId ?? "", sessionPath: "", hostId: currentHost(), name: task.name, task: task.task, status: "running", startedAt: Date.now() };
  results.push(run);
  let claimed = false;

  try {
    signal?.throwIfAborted();
    const child = await createSubagent(pi, ctx, task, toolCallId, signal);

    if (active.has(child.sessionId)) throw new Error("This subagent is already running");
    Object.assign(run, child);

    creationIntent(run, signal);
    lifecycle.run = run;
    active.set(run.sessionId, lifecycle); claimed = true;
    saveRun(pi, ctx, run); publish(run);
    execution.ready();
    await observeSubagent(run, { ...execution, signal }, lifecycle, true);
  } catch (error) {
    if (!claimed) { failedCreation(run, signal.aborted, (error instanceof Error ? error.message : String(error))); }
    else { run.observation = "interrupted"; ctx.ui.notify(`Subagent supervision interrupted: ${(error instanceof Error ? error.message : String(error))}`, "error"); }
  }

  lifecycle.closing = true;
  started();

  if (claimed && active.get(run.sessionId) === lifecycle) active.delete(run.sessionId);

  try {
    if (claimed) publishObservedRun(execution, run);
  }
  finally { finished(); }
}

function failedCreation(run: SubagentRun, aborted: boolean, error: string) {
  run.status = aborted ? "cancelled" : "failed";
  run.output = error;
}

function creationIntent(run: SubagentRun, signal: AbortSignal) {
  if (signal.aborted && signal.reason instanceof SubagentCancellation) { run.cancelRequested = true; run.cancelReason = signal.reason.message; }
}

function publishObservedRun(execution: SubagentExecution, run: SubagentRun) {
  if (run.status !== "running") { finishRun(execution.pi, execution.ctx, run); execution.publish(run); }
  else saveRun(execution.pi, execution.ctx, run);
}

async function launchSubagent(task: SubagentTask, execution: Omit<SubagentExecution, "ready">, pending: Set<Promise<void>>) {
  return new Promise<void>((ready, reject) => {
    const completion = (async () => {
      if (task.sessionId) await recoverPreviousRuns(task.sessionId, execution);
      await executeSubagent(task, { ...execution, ready });
    })()
      .catch(error => {
        reject(error);
        execution.ctx.ui.notify(`Subagent failed: ${(error instanceof Error ? error.message : String(error))}`, "error");
      })
      .finally(() => { ready(); pending.delete(completion); });

    pending.add(completion);
  });
}

async function recoverPreviousRuns(sessionId: string, execution: Omit<SubagentExecution, "ready">) {
  if (execution.active.has(sessionId)) throw new Error("This subagent is already running");

  for (const run of await savedSubagentRuns(execution.ctx)) {
    if (run.sessionId !== sessionId) continue;

    if (run.status === "running") throw new Error("This child's previous task remains unresolved");

  }
}

export function registerSubagents(pi: ExtensionAPI) {
  const resultsDelivery = registerSubagentResults(pi);
  const active = new Map<string, ActiveSubagent>();
  const pending = new Set<Promise<void>>();
  let controller = new AbortController();
  let context: ExtensionContext | undefined;
  const taskPath = (ctx: ExtensionContext, run: SubagentRun) => run.taskPath ?? `${delegationScope(ctx).taskPath}/${run.name}`;

  const targetRun = (ctx: ExtensionContext, target: string) => {
    const runs = latestRuns(ctx).filter(run => run.sessionId === target || run.name === target || taskPath(ctx, run) === target);

    if (runs.length !== 1) throw new Error("No subagent has this nickname; list_subagents shows their nicknames");

    return runs[0];
  };

  const start = async (task: SubagentTask, toolCallId: string, ctx: ExtensionContext, signal?: AbortSignal) => {
    signal?.throwIfAborted();

    requireDelegation(ctx);
    reconcile(ctx);

    if (latestRuns(ctx).some(run => run.sessionId === task.sessionId && run.status === "running")) throw new Error("This subagent's previous task is unresolved; stop it with stop_subagent first");

    requireSubagentSlots(pi, ctx, pending.size, 1);
    const results: SubagentRun[] = [];
    const backgroundSignal = controller.signal;
    await launchSubagent(task, { pi, ctx, toolCallId, active, results, signal: backgroundSignal, publish(run) {
      if (backgroundSignal.aborted || run.status === "running") return;
      resultsDelivery.publish(ctx, run);
    } }, pending);

    return { ...subagentPayload(results), isError: results.some(run => run.status === "failed" || run.status === "cancelled") };
  };

  const useProfilesTool = agentProfilesTool(pi);
  /** Whether the session's folder is in a Git repository, checked once per session. */
  let repository: { sessionId: string; inside: boolean } | undefined;
  const sessionInRepository = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();

    if (repository?.sessionId !== sessionId) repository = { sessionId, inside: inGitRepository(ctx.cwd) };

    return repository.inside;
  };
  pi.on("session_start", (_event, ctx) => { sessionInRepository(ctx); });
  const unsubscribeTools = pi.events.on("piop:required-tools", ({ ctx, tools, availableTools }) => {
    const allowed = availableTools ?? pi.getActiveTools();
    const child = subagentParent(ctx);
    const reviewer = ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-review-parent");
    const subagents = allowed.some(tool => SUBAGENT_TOOLS.includes(tool));
    const peers = !child && !reviewer && allowed.some(tool => PEER_TOOLS.includes(tool));

    // Saved children stay reachable after their tools are turned off.
    if (subagents || latestRuns(ctx).length) tools.push(...SUBAGENT_TOOLS);

    // branchoff_peer makes a Git worktree, so only a chat in a Git repository gets it.
    if (peers) tools.push(...PEER_TOOLS.filter(tool => tool !== "branchoff_peer" || sessionInRepository(ctx)));

    if (useProfilesTool(subagents, peers)) tools.push("list_agent_profiles");
  });

  pi.on("session_shutdown", unsubscribeTools);
  pi.registerTool({
    name: "list_subagents", label: "List subagents", exposure: "model-only", description: "List your subagents with their nicknames, agents and status.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const subagents = await Promise.all(latestRuns(ctx).map(async run => {
        const nickname = run.name;

        if (run.status !== "running") return { nickname, agent: run.agent, status: run.status };

        try { return { nickname, agent: run.agent, status: snapshotStatus(await sessionSnapshot(run.sessionId, run.hostId, signal)) === "idle" ? "finishing" : "running" }; }
        catch (error) { return { nickname, agent: run.agent, status: "unavailable", error: error instanceof Error ? error.message : String(error) }; }
      }));

      return { content: [{ type: "text", text: JSON.stringify(subagents) }], details: { subagents } };
    },
  });
  pi.registerTool({
    name: "message_subagent", label: "Message subagent", exposure: "model-only", description: "Send a subagent a message. A busy subagent gets it as a follow-up after its current work, or during it with delivery: \"steer\". A finished one starts a new task with its own earlier history. Its answer arrives as a new message.",
    parameters: Type.Object({ nickname: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), delivery: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("steer")])) }),
    async execute(id, params, signal, _update, ctx) {
      requireMessageLength(params.message);
      const run = targetRun(ctx, params.nickname);
      reconcile(ctx);

      const running = active.get(run.sessionId);

      if (running) {
        await running.ready;

        if (!running.closing) return deliverFollowup(pi, ctx, run, running, params.message, params.delivery === "steer" ? "steer" : "followUp", signal);
        await running.done;
      }

      if (latestRuns(ctx).some(item => item.sessionId === run.sessionId && item.status === "running")) throw new Error("This subagent's previous task is unresolved; stop it with stop_subagent first");

      return start({ name: run.name, task: params.message, sessionId: run.sessionId }, id, ctx, signal);
    },
  });
  pi.registerTool({
    name: "stop_subagent", label: "Stop subagent", exposure: "model-only", description: "Stop a subagent's current task. It keeps its history and can get more work with message_subagent.",
    parameters: Type.Object({ nickname: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      reconcile(ctx);
      const run = targetRun(ctx, params.nickname);
      const running = active.get(run.sessionId);
      const stopped = { content: [{ type: "text" as const, text: `Subagent ${run.name} stopped.` }], details: { name: run.name } };

      if (running) {
        cancelSubagent(pi, ctx, running, "Subagent stopped by stop_subagent");
        await running.done;

        if (latestRuns(ctx).find(item => item.sessionId === run.sessionId)?.status === "running") throw new Error("Subagent cancellation is not yet confirmed");

        return stopped;
      }

      run.cancelRequested = true;
      run.cancelReason = "Subagent stopped by stop_subagent";
      saveRun(pi, ctx, run);
      await interruptSession(run.sessionId, run.hostId, signal);

      if (run.status === "running") { run.status = "cancelled"; finishRun(pi, ctx, run); resultsDelivery.publish(ctx, run); }

      return stopped;
    },
  });

  let stopping: Promise<void> | undefined;
  let detachAbort = () => {};

  const stop = (intentional = true) => {
    if (stopping) return stopping;

    if (intentional && context) {
      reconcile(context);

      for (const lifecycle of active.values()) cancelSubagent(pi, context, lifecycle, "Subagent cancelled with its parent");
    }

    controller.abort(intentional ? new SubagentCancellation("Subagent cancelled with its parent") : new Error("Subagent observation interrupted"));
    stopping = Promise.allSettled([...pending]).then(() => {
      controller = new AbortController();
      stopping = undefined;
    });

    return stopping;
  };

  const cancel = () => { void stop(); };

  const unsubscribeCancellation = pi.events.on("piop:cancel-preparation", cancel);

  const reconcile = (ctx: ExtensionContext) => {
    context = ctx;

    resultsDelivery.flush(ctx);

    for (const saved of latestRuns(ctx)) {
      if (saved.status !== "running") {
        if (saved.resultDelivery === "pending") resultsDelivery.publish(ctx, structuredClone(saved));
        continue;
      }

      if (active.has(saved.sessionId)) continue;
      const run = structuredClone(saved);
      run.runId ??= `${run.toolCallId}:${run.startedAt}`;

      if (run.submission === "prepared") {
        run.status = run.cancelRequested ? "cancelled" : "failed"; run.output = "The task was not submitted before supervision was interrupted";
        finishRun(pi, ctx, run); resultsDelivery.publish(ctx, run); continue;
      }

      const childController = new AbortController();
      let started = () => {};

      let finished = () => {};

      const ready = new Promise<void>(resolve => { started = resolve; });
      const done = new Promise<void>(resolve => { finished = resolve; });
      const lifecycle: ActiveSubagent = { controller: childController, ready, done, started, closing: false, revision: 0, pendingDeliveries: 0, deliveryIds: new Set(run.deliveryIds), run };
      active.set(run.sessionId, lifecycle);

      const signal = AbortSignal.any([controller.signal, childController.signal]);

      const completion = observeSubagent(run, { pi, ctx, signal }, lifecycle, false)
        .then(() => {
          lifecycle.closing = true; started();

          if (run.status !== "running") { finishRun(pi, ctx, run); resultsDelivery.publish(ctx, run); }
          else { run.observation = "interrupted"; saveRun(pi, ctx, run); }
        })
        .catch(error => ctx.ui.notify(`Subagent supervision interrupted: ${(error instanceof Error ? error.message : String(error))}`, "error"))
        .finally(() => { lifecycle.closing = true; started(); active.delete(run.sessionId); pending.delete(completion); finished(); });

      pending.add(completion);
    }
  };

  const restoreSubagents = async (ctx: ExtensionContext) => {
    await stopping;
    resultsDelivery.reset();
    const tracked = new Set(ownedRuns(ctx).map(run => JSON.stringify(run)));

    for (const run of await savedSubagentRuns(ctx)) if (!tracked.has(JSON.stringify(run))) saveRun(pi, ctx, run);
    reconcile(ctx);
  };

  pi.on("session_start", (_event, ctx) => restoreSubagents(ctx).catch(error => ctx.ui.notify(`Subagent restoration remains pending: ${(error instanceof Error ? error.message : String(error))}`, "error")));

  pi.on("agent_start", async (_event, ctx) => {
    await stopping;
    reconcile(ctx);
    detachAbort();
    const signal = ctx.signal;
    signal?.addEventListener("abort", cancel, { once: true });
    detachAbort = () => signal?.removeEventListener("abort", cancel);

    if (signal?.aborted) await stop();
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome === "aborted" || ctx.signal?.aborted) { await stop();

    return; }

    if (subagentParent(ctx)) while (pending.size) await Promise.allSettled([...pending]);
  });
  pi.on("session_before_switch", () => stop());
  pi.on("session_shutdown", async (event) => { detachAbort(); unsubscribeCancellation(); await stop(event.reason !== "reload"); });
  const inputListeners = new Set<() => void>();
  pi.on("input", event => { if (event.source !== "extension") for (const listener of [...inputListeners]) listener(); });
  pi.registerTool({
    name: "await_subagents", label: "Await subagents", exposure: "model-only",
    description: "Wait until any of your subagents finishes (for: \"any\", the default) or until all of them finish (for: \"all\"), or until the user sends a new message. Returns the answers of the subagents that finished.",
    parameters: Type.Object({ for: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])) }),
    async execute(_id, params, signal, _update, ctx) {
      reconcile(ctx);
      const all = params.for === "all";
      const userMessage = { content: [{ type: "text" as const, text: "The user sent a new message. Subagents are still running." }], details: { finished: false } };

      const answers = () => {
        const finished = resultsDelivery.claim(ctx);
        const text = finished.length ? subagentResponses(finished) : "No subagent answers are waiting.";

        return { content: [{ type: "text" as const, text: pending.size ? text + "\n\nOther subagents are still running." : text }], details: { finished: !pending.size, version: 1, runs: finished } };
      };

      // An answer that is already waiting ends a wait for any subagent at once.
      if (!pending.size || (!all && resultsDelivery.waiting(ctx))) return answers();
      let onInput = () => {};
      const input = new Promise<"input">(resolve => { onInput = () => resolve("input"); inputListeners.add(onInput); });
      const aborted = new Promise<"aborted">(resolve => { if (signal?.aborted) resolve("aborted"); signal?.addEventListener("abort", () => resolve("aborted"), { once: true }); });

      try {
        while (pending.size) {
          if (ctx.hasPendingMessages()) return userMessage;
          const running = [...pending];
          const settled = (all ? Promise.allSettled(running) : Promise.race(running.map(item => item.then(() => {}, () => {})))).then(() => "settled" as const);
          const outcome = await Promise.race([settled, input, aborted]);

          if (outcome === "aborted") signal?.throwIfAborted();

          if (outcome === "input") return userMessage;
          reconcile(ctx);

          if (!all && resultsDelivery.waiting(ctx)) return answers();
        }
      } finally { inputListeners.delete(onInput); }

      if (latestRuns(ctx).some(run => run.status === "running")) throw new Error("Subagent work remains unresolved; completion has not been confirmed");

      return answers();
    },
  });
  pi.registerTool({
    name: "spawn_subagents", label: "Spawn subagents",
    exposure: "model-only",
    description: "Start subagents in the background, each with its own task. A subagent starts with no context, so fill him in just enough to complete the handoff. Avoid giving two subagents overlapping edits. Pick an agent profile from list_agent_profiles or omit it to use your own.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ nickname: Type.String({ pattern: NICKNAME, description: "Unique, used to address this subagent" }), task: Type.String({ minLength: 1 }), agent: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1 }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();

      requireDelegation(ctx);

      if (!params.tasks.length || params.tasks.some((task) => !task.task.trim())) throw new Error("Provide at least one nonempty task");
      for (const task of params.tasks) requireMessageLength(task.task);

      // A nickname is shown on its own line, as in "Subagent <nickname>:".
      if (params.tasks.some(task => !new RegExp(NICKNAME).test(task.nickname))) throw new Error("Give each subagent a nickname of 1–8 characters: an upper case letter, then lower case letters or digits");

      if (new Set(params.tasks.map(task => task.nickname)).size !== params.tasks.length) throw new Error("Give each subagent a different nickname");

      reconcile(ctx);

      if (params.tasks.some(task => latestRuns(ctx).some(run => run.name === task.nickname))) throw new Error("A subagent with this nickname exists; use message_subagent to give it more work");

      requireSubagentSlots(pi, ctx, pending.size, params.tasks.length);
      const results: SubagentRun[] = [];
      const backgroundSignal = controller.signal;

      const publish = (run: SubagentRun) => {
        if (backgroundSignal.aborted) return;

        if (run.status === "running") { onUpdate?.(subagentPayload(results));

        return; }

        resultsDelivery.publish(ctx, run);
      };

      await Promise.all(params.tasks.map((task) => launchSubagent({ name: task.nickname, task: task.task, agent: task.agent }, { pi, ctx, toolCallId, active, results, signal: backgroundSignal, publish }, pending)));

      return { ...subagentPayload(results), isError: results.some((run) => run.status === "failed" || run.status === "cancelled") };
    },
  });
}
