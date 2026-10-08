import type { AgentToolResult, ExtensionAPI, ExtensionContext, CustomEntryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { resolveAgentProfile } from "./agent-profiles.ts";
import type { GoalScope } from "./goals.ts";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { BrokerRequestError, currentHost, request } from "./client.ts";
import { createdWorktreeSchema } from "./fork.ts";
import { writeSessionFile } from "./session-file.ts";
import { goalTokens } from "./goal-state.ts";
import { listenSubagentUsage, registerSubagentUsage } from "./subagent-usage.ts";
import { registerSubagentMailbox } from "./subagent-mailbox.ts";
import { interruptSession, sendAgentMailbox, sendSessionMessage, sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { setTimeout as delay } from "node:timers/promises";

const SUBAGENT_RUN = "piop-subagent-run";

const SUBAGENT_PARENT = "piop-subagent-parent";

const SUBAGENT_TIMEOUT_MS = 600_000;

const MAX_DELEGATION_DEPTH = 2;

const parentSchema = Schema.Object({
  parentSessionId: Schema.String(), depth: Schema.Optional(Schema.Integer({ minimum: 1 })),
  taskPath: Schema.Optional(Schema.String()), parentTaskPath: Schema.Optional(Schema.String()),
});

function subagentParent(ctx: ExtensionContext) {
  const entry = ctx.sessionManager.getEntries().find(item => item.type === "custom" && item.customType === SUBAGENT_PARENT);

  return entry?.type === "custom" ? Parse(parentSchema, entry.data) : undefined;
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

const worktreeChoice = Type.Union([Type.Literal("same"), Type.Literal("new")], { description: "Required for spawning: same shares the caller's working directory; new creates a separate Git worktree with the caller's current changes. Resumed children retain their original choice." });

type SubagentTask = { task: string; name: string; agent?: string; sessionId?: string; fork_turns?: string; worktree?: "same" | "new" };

const runSchema = Schema.Object({
  version: Schema.Literal(1), toolCallId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), sessionPath: Schema.String(),
  hostId: Schema.String(), name: Schema.String(), task: Schema.String(), status: Schema.Union([Schema.Literal("running"), Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
  startedAt: Schema.Number(), endedAt: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.String()), apiCost: Schema.Optional(Schema.Number()),
  agent: Schema.Optional(Schema.String()), taskPath: Schema.Optional(Schema.String()),
  cwd: Schema.Optional(Schema.String()), worktree: Schema.Optional(Schema.Union([Schema.Literal("same"), Schema.Literal("new")])), branch: Schema.Optional(Schema.String()),
});

const usageSchema = Schema.Object({ input: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.Number()), cacheWrite: Schema.Optional(Schema.Number()), cost: Schema.Optional(Schema.Object({ total: Schema.Optional(Schema.Number()) })) });

const transcriptEntrySchema = Schema.Object({ type: Schema.String(), usage: Schema.Optional(usageSchema), message: Schema.Optional(Schema.Unknown()) });

const descendantUsageSchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal("piop-subagent-usage"), data: Schema.Object({ tokens: Schema.Integer({ minimum: 0 }) }) });

const assistantSchema = Schema.Object({ role: Schema.Literal("assistant"), stopReason: Schema.String(), errorMessage: Schema.Optional(Schema.String()), content: Schema.Array(Schema.Unknown()), usage: Schema.Optional(usageSchema) });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

type SubagentResponse = Static<typeof assistantSchema>;

type SubagentRun = Static<typeof runSchema>;

function completedSubagentOutput(last: SubagentResponse | undefined) {
  if (!last) throw new Error("Subagent produced no assistant response; inspect its transcript");

  if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `Subagent ${last.stopReason}`);

  if (last.stopReason === "toolUse") throw new Error("Subagent stopped before completing its task");
  const output = last.content.flatMap((part) => Check(textSchema, part) ? [part.text] : []).join("\n") || "(No text returned; inspect the saved transcript.)";

  return output.length > 16_000 ? `${output.slice(0, 16_000)}\n[Result truncated. Full conversation is saved in the child transcript.]` : output;
}

function subagentEntryCost(usage: Static<typeof usageSchema> | undefined) {
  const amount = usage?.cost?.total;

  return amount !== undefined && Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

async function subagentCompletion(run: SubagentRun, offset: number, reportUsage: (tokens: number) => Promise<void>) {
  let last: SubagentResponse | undefined;
  let cost = 0;
  let tokens = 0;
  const input = createReadStream(run.sessionPath, { start: offset });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      let entry;

      try { entry = JSON.parse(line); } catch { continue; }

      if (Check(descendantUsageSchema, entry)) { tokens += entry.data.tokens; continue; }

      if (!Check(transcriptEntrySchema, entry)) continue;

      if (entry.type !== "message") { tokens += goalTokens(entry.usage); cost += subagentEntryCost(entry.usage); continue; }

      if (!Check(assistantSchema, entry.message)) continue;
      last = entry.message;
      cost += subagentEntryCost(last.usage);
      tokens += goalTokens(last.usage);
    }
  } finally { lines.close(); input.destroy(); await reportUsage(tokens); }

  run.apiCost = cost;

  return last;
}

function validateFork(task: SubagentTask) {
  const forkTurns = task.fork_turns ?? "none";

  if (forkTurns !== "none" && forkTurns !== "all" && !/^[1-9]\d*$/.test(forkTurns)) throw new Error("fork_turns must be none, all, or a positive turn count");

  return forkTurns;
}

function completedHistory(ctx: ExtensionContext) {
  const branch = structuredClone(ctx.sessionManager.getBranch()).filter(entry => entry.type !== "custom");
  const pending = new Map<string, number>();
  branch.forEach((entry, index) => {
    if (entry.type !== "message") return;

    if (entry.message.role === "assistant") {
      for (const part of entry.message.content) if (part.type === "toolCall") pending.set(part.id, index);
    }

    if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
  });

  return branch.slice(0, Math.min(branch.length, ...pending.values()));
}

function inheritedHistory(ctx: ExtensionContext, task: SubagentTask) {
  const forkTurns = validateFork(task);
  let retained = forkTurns === "none" ? [] : completedHistory(ctx);

  if (task.agent) retained = retained.filter(entry => entry.type !== "model_change" && entry.type !== "thinking_level_change");

  if (forkTurns !== "all" && forkTurns !== "none") {
    const starts = retained.flatMap((entry, index) => entry.type === "message" && entry.message.role === "user" ? [index] : []);
    retained = retained.slice(starts[Math.max(0, starts.length - Number(forkTurns))] ?? 0);
  }

  return retained;
}

async function waitForSubagent(run: SubagentRun, signal: AbortSignal, lifecycle: ActiveSubagent) {
  const deadline = Date.now() + SUBAGENT_TIMEOUT_MS;
  let failures = 0;

  while (true) {
    signal.throwIfAborted();

    if (Date.now() >= deadline) throw new Error("Subagent timed out after ten minutes");

    try {
      const revision = lifecycle.revision;
      const snapshot = await sessionSnapshot(run.sessionId, run.hostId, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]));
      failures = 0;

      if (finishObservedRun(snapshotStatus(snapshot), revision, lifecycle)) return;
    } catch (error) {
      signal.throwIfAborted();

      if (Date.now() >= deadline) throw new Error("Subagent timed out after ten minutes");

      if (!(error instanceof BrokerRequestError) || !error.transient) throw error;
      failures++;
    }

    await delay(Math.min(500 * 2 ** Math.min(failures, 4) + Math.random() * 250, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
}

async function subagentWorkspace(ctx: ExtensionContext, task: SubagentTask, sessionId: string, signal?: AbortSignal) {
  if (task.worktree === "same") return { cwd: ctx.cwd, worktree: task.worktree };

  if (task.worktree !== "new") throw new Error("Choose worktree explicitly: same or new");
  const name = `agent-${sessionId}`;
  const created = Parse(createdWorktreeSchema, await request("/worktrees/create", { cwd: ctx.cwd, name, hostId: currentHost() }, signal, 600_000));

  if (created.setupError) throw new Error(`Worktree retained at ${created.path} (${created.branch}), but setup failed: ${created.setupError}`);

  return { cwd: created.path, worktree: task.worktree, branch: created.branch };
}

function resumeSubagent(runs: SubagentRun[], parentSessionId: string, task: SubagentTask, toolCallId: string): SubagentRun {
  if (task.agent) throw new Error("A resumed subagent keeps its original agent profile");
  const previous = runs.find(run => run.parentSessionId === parentSessionId && run.sessionId === task.sessionId && run.hostId === currentHost() && run.sessionPath);

  if (!previous) throw new Error("Only a child created by this conversation can be resumed");

  if (task.worktree && task.worktree !== (previous.worktree ?? "same")) throw new Error("A resumed subagent keeps its original worktree choice; use followup_task or spawn a new child");

  return { ...previous, toolCallId, name: task.name, task: task.task, status: "running", startedAt: Date.now(), endedAt: undefined, output: undefined, apiCost: undefined };
}

async function createSubagent(pi: ExtensionAPI, ctx: ExtensionContext, task: SubagentTask, toolCallId: string, signal?: AbortSignal): Promise<SubagentRun> {
  const scope = requireDelegation(ctx);
  const parentSessionId = ctx.sessionManager.getSessionId();
  const runs = ctx.sessionManager.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RUN ? [Parse(runSchema, entry.data)] : []);

  if (task.sessionId) return resumeSubagent(runs, parentSessionId, task, toolCallId);

  const header = ctx.sessionManager.getHeader();

  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before delegating work");
  const profile = await resolveAgentProfile(pi, task.agent);
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  let retained = inheritedHistory(ctx, task);
  const workspace = await subagentWorkspace(ctx, task, sessionId, signal);
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId, sessionId, sessionPath, hostId: currentHost(), name: task.name, task: task.task, taskPath: `${scope.taskPath}/${task.name}`, agent: profile.active, status: "running", startedAt: Date.now(), ...workspace };
  let parentId: string | null = null;
  retained = retained.map(item => { const next = { ...item, parentId }; parentId = next.id;

  return next; });

  const entry = (value: CustomEntryDraft | { type: "session_info"; name: string }) => { const id = randomUUID().slice(0, 8); const result = { ...value, id, parentId, timestamp }; parentId = id;

  return result; };

  try { await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: workspace.cwd },
    ...retained,
    entry({ type: "session_info", name: `Subagent: ${task.name}` }),
    entry({ type: "custom", customType: SUBAGENT_PARENT, data: { version: 1, parentSessionId, parentSessionPath: ctx.sessionManager.getSessionFile(), toolCallId, task: task.task, depth: scope.depth + 1, taskPath: run.taskPath, parentTaskPath: scope.taskPath } }),
    entry({ type: "custom", customType: "pi-define-agents-state", data: profile }),
  ]); } catch (error) { throw new Error(`Subagent session creation failed in ${workspace.cwd}; any created worktree is retained: ${String(error)}`); }

  return run;
}

type ActiveSubagent = { controller: AbortController; done: Promise<void>; ready: Promise<void>; started: () => void; closing: boolean; revision: number; pendingDeliveries: number; deliveryIds: Set<string> };

function finishObservedRun(status: string, revision: number, lifecycle: ActiveSubagent) {
  if (status !== "idle" || revision !== lifecycle.revision || lifecycle.pendingDeliveries) return false;
  lifecycle.closing = true;

  return true;
}

async function deliverFollowup(ctx: ExtensionContext, run: SubagentRun, lifecycle: ActiveSubagent, message: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  lifecycle.controller.signal.throwIfAborted();
  signal?.throwIfAborted();
  lifecycle.revision++;
  lifecycle.pendingDeliveries++;
  const deliveryId = randomUUID();
  lifecycle.deliveryIds.add(deliveryId);

  try {
    const data = await sendSessionMessage(ctx, run.sessionId, run.hostId, message, true, signal, deliveryId);

    return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  } catch (error) { lifecycle.controller.abort(error); throw error; }
  finally { lifecycle.revision++; lifecycle.pendingDeliveries--; }
}

class SubagentRetiredError extends Error {}

type SubagentExecution = { pi: ExtensionAPI; ctx: ExtensionContext; toolCallId: string; active: Map<string, ActiveSubagent>; results: SubagentRun[]; signal?: AbortSignal; ready: () => void; publish: (run: SubagentRun) => void; reportDescendants: (tokens: number, ctx: ExtensionContext) => Promise<void> };

async function confirmSubagentStopped(run: SubagentRun, ctx: ExtensionContext, deliveryId: string) {
  let notified = false;

  while (true) {
    try { const receipt = await interruptSession(run.sessionId, run.hostId, undefined, deliveryId);

    return Check(Schema.Object({ retired: Schema.Literal(true) }), receipt); } catch (error) {
      if (!notified) ctx.ui.notify(`Cancellation is not confirmed for ${run.name}; continuing to retry: ${String(error)}`, "error");
      notified = true;
      await delay(2000);
    }
  }
}

async function dispatchSubagent(run: SubagentRun, execution: SubagentExecution, lifecycle: ActiveSubagent) {
  const { signal, pi, ctx } = execution;
  signal?.throwIfAborted();
  const offset = (await stat(run.sessionPath)).size;
  const scope: GoalScope = { ctx };
  pi.events.emit("piop:goal-scope", scope);
  await scope.ready;
  let reported = 0;

  const reportUsage = async (total: number) => {
    const tokens = Math.max(0, total - reported);
    reported = Math.max(reported, total);

    if (!tokens) return;
    pi.appendEntry("piop-subagent-usage", { tokens });
    pi.events.emit("piop:goal-usage", { goalId: scope.goalId, tokens, ctx });
    await execution.reportDescendants(tokens, ctx);
  };

  const usageFailure = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, usageFailure.signal]) : usageFailure.signal;
  const closeUsage = await listenSubagentUsage(run.sessionPath, reportUsage, error => { usageFailure.abort(error); });

  let dispatched = false;
  let submitted = false;
  const deliveryId = randomUUID();
  lifecycle.deliveryIds.add(deliveryId);
  let last: SubagentResponse | undefined;

  try {
    requestSignal.throwIfAborted();
    submitted = true;
    await sendSessionMessage(ctx, run.sessionId, run.hostId, run.task, true, undefined, deliveryId);
    lifecycle.started();

    await waitForSubagent(run, requestSignal, lifecycle);
    dispatched = true;
  } catch (error) {
    lifecycle.closing = true;

    if (submitted) {
      const retired: boolean[] = [];

      for (const id of lifecycle.deliveryIds) retired.push(await confirmSubagentStopped(run, ctx, id));

      if (retired.some(Boolean)) throw new SubagentRetiredError("Subagent was archived or deleted; its worker has stopped");
    }

    throw error;
  }

  finally {
    try { await closeUsage(); last = await subagentCompletion(run, offset, reportUsage); }
    catch (error) { if (dispatched) throw error; }
  }

  run.output = completedSubagentOutput(last);
  run.status = "completed";
}

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
    active.set(run.sessionId, lifecycle); claimed = true;
    pi.appendEntry(SUBAGENT_RUN, { ...run }); publish(run);
    execution.ready();
    await dispatchSubagent(run, { ...execution, signal }, lifecycle);
  } catch (error) {
    run.status = signal.aborted || error instanceof SubagentRetiredError ? "cancelled" : "failed";
    run.output = error instanceof Error ? error.message : String(error);
  }

  lifecycle.closing = true;
  started();

  if (claimed) active.delete(run.sessionId);
  run.endedAt = Date.now();

  try { pi.appendEntry(SUBAGENT_RUN, { ...run }); publish(run); }
  finally { finished(); }
}

function subagentPayload(runs: SubagentRun[]): AgentToolResult<{ version: 1; runs: SubagentRun[] }> {
  return { content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.status}\nAgent profile: ${run.agent ?? "original profile"}\nSession: ${run.hostId}/${run.sessionId}\nWorkspace: ${run.cwd ?? "original working directory"} (${run.worktree ?? "same"})${run.branch ? `\nBranch: ${run.branch}` : ""}\nTranscript: ${run.sessionPath}${run.output ? `\n${run.output}` : ""}`).join("\n\n") }], details: { version: 1, runs: structuredClone(runs) } };
}

function launchSubagent(task: SubagentTask, execution: Omit<SubagentExecution, "ready">, pending: Set<Promise<void>>) {
  return new Promise<void>((ready) => {
    const completion = executeSubagent(task, { ...execution, ready })
      .catch(error => execution.ctx.ui.notify(`Subagent failed: ${String(error)}`, "error"))
      .finally(() => { ready(); pending.delete(completion); });

    pending.add(completion);
  });
}

export function registerSubagents(pi: ExtensionAPI) {
  const reportDescendants = registerSubagentUsage(pi);
  const mailbox = registerSubagentMailbox(pi);
  const active = new Map<string, ActiveSubagent>();
  const pending = new Set<Promise<void>>();
  let controller = new AbortController();
  const latestRuns = (ctx: ExtensionContext) => [...new Map(ctx.sessionManager.getEntries().flatMap<[string, SubagentRun]>(entry => entry.type === "custom" && entry.customType === SUBAGENT_RUN && Check(runSchema, entry.data) ? [[entry.data.sessionId, entry.data]] : [])).values()];
  const taskPath = (ctx: ExtensionContext, run: SubagentRun) => run.taskPath ?? `${delegationScope(ctx).taskPath}/${run.name}`;

  const targetRun = (ctx: ExtensionContext, target: string) => {
    const runs = latestRuns(ctx).filter(run => run.sessionId === target || run.name === target || taskPath(ctx, run) === target);

    if (runs.length !== 1) throw new Error("Use a unique child session ID or task name from list_agents");

    return runs[0];
  };

  const start = async (task: SubagentTask, toolCallId: string, ctx: ExtensionContext, signal?: AbortSignal) => {
    signal?.throwIfAborted();

    requireDelegation(ctx);

    if (pending.size >= 8) throw new Error("All eight subagent slots are occupied; wait for a child to finish");

    if (!task.sessionId && latestRuns(ctx).some(run => run.name === task.name)) throw new Error("Task name already exists; use followup_task to reuse the child");
    const results: SubagentRun[] = [];
    const backgroundSignal = controller.signal;
    await launchSubagent(task, { pi, ctx, toolCallId, active, results, reportDescendants, signal: backgroundSignal, publish(run) {
      if (backgroundSignal.aborted || run.status === "running") return;
      const notificationId = randomUUID();
      const payload = subagentPayload([run]);
      sendAgentMailbox(pi, ctx, { customType: "piop-subagent-result", ...payload, details: { ...payload.details, notificationId }, display: true }, notificationId);
    } }, pending);

    return { ...subagentPayload(results), isError: results.some(run => run.status === "failed" || run.status === "cancelled") };
  };

  const unsubscribeTools = pi.events.on("piop:required-tools", ({ ctx, tools, availableTools }) => {
    const allowed = availableTools ?? pi.getActiveTools();
    const child = ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === SUBAGENT_PARENT);
    const reviewer = ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "piop-review-parent");

    if (allowed.includes("subagent") || latestRuns(ctx).length) tools.push("spawn_agent", "followup_task", "interrupt_agent", "list_agents", "list_agent_profiles", "send_message", "wait_agent", "await_subagents");

    if (child) tools.push("send_message", "wait_agent");

    if (!child && !reviewer && allowed.includes("send_message")) tools.push("send_message_to_thread", "stop_thread", "read_thread", "wait_threads", "list_threads", "create_thread", "list_agent_profiles");
  });

  pi.on("session_shutdown", unsubscribeTools);
  pi.registerTool({
    name: "spawn_agent", label: "Spawn agent", exposure: "model-only",
    description: "Start one background child and return its session ID and agent profile. Use list_agent_profiles to discover exact agent names. Passing agent uses that profile's prompts, model, effort, tools, skills, extensions and MCP configuration; omitting it inherits the caller's profile and overrides. Profile choice is independent of fork_turns: none (default), all, or a positive number of recent user turns. Up to eight children per parent run concurrently. Delegation has at most two levels: root → child → grandchild; grandchildren cannot delegate. worktree is required: same shares files with the caller; new creates a separate Git worktree, copies current changes and runs configured setup. Created worktrees are retained. Final results start a new parent turn immediately if idle, or after the parent agent settles. Use followup_task for more work and send_message for updates. Finish your current run when waiting for mailbox delivery. Children are cancelled on parent close/switch and time out after ten minutes.",
    parameters: Type.Object({ task_name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), message: Type.String({ minLength: 1, maxLength: 100_000 }), worktree: worktreeChoice, agent: Type.Optional(Type.String({ minLength: 1, description: "Exact configured profile name from list_agent_profiles; omit to inherit the caller" })), fork_turns: Type.Optional(Type.String()) }),
    async execute(id, params, signal, _update, ctx) { return start({ name: params.task_name, task: params.message, agent: params.agent, fork_turns: params.fork_turns, worktree: params.worktree }, id, ctx, signal); },
  });
  pi.registerTool({
    name: "list_agents", label: "List child agents", exposure: "model-only", description: "List this parent's saved child sessions, task paths and current status. Returned paths (such as /root/child/grandchild), local task names and session IDs address children. Independent chats are listed by list_threads.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const agents = await Promise.all(latestRuns(ctx).map(async run => {
        try { const snapshot = await sessionSnapshot(run.sessionId, run.hostId, signal);

        return { sessionId: run.sessionId, task_name: taskPath(ctx, run), agent: run.agent, cwd: run.cwd, worktree: run.worktree, branch: run.branch, status: snapshotStatus(snapshot), lastRunStatus: run.status }; }
        catch (error) { return { sessionId: run.sessionId, task_name: taskPath(ctx, run), cwd: run.cwd, worktree: run.worktree, branch: run.branch, status: "unavailable", error: String(error) }; }
      }));

      return { content: [{ type: "text", text: JSON.stringify(agents) }], details: { agents } };
    },
  });
  pi.registerTool({
    name: "send_message", label: "Message agent", exposure: "model-only", description: "Deliver an update to a child by session ID or task name, or to parent from a child. Starts an idle recipient immediately; a busy recipient queues the message until its agent settles, then starts a new turn. Returns acceptance, not a reply. Use send_message_to_thread for independent chats.",
    parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1, maxLength: 100_000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const parent = subagentParent(ctx);
      const parentTargets = parent ? ["parent", parent.parentTaskPath ?? "/root", parent.parentSessionId] : [];
      const id = parent && parentTargets.includes(params.target) ? parent.parentSessionId : targetRun(ctx, params.target).sessionId;
      const data = await sendSessionMessage(ctx, id, currentHost(), params.message, true, signal);

      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  });
  pi.registerTool({
    name: "followup_task", label: "Follow up with agent", exposure: "model-only", description: "Give an existing child more work. Starts an idle child or steers a running child. Preserves the child's worktree, profile and history. Its final response is delivered through the parent mailbox.",
    parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1, maxLength: 100_000 }) }),
    async execute(id, params, signal, _update, ctx) {
      const run = targetRun(ctx, params.target);

      const running = active.get(run.sessionId);

      if (running) {
        await running.ready;

        if (!running.closing) return deliverFollowup(ctx, run, running, params.message, signal);
        await running.done;
      }

      return start({ name: run.name, task: params.message, sessionId: run.sessionId }, id, ctx, signal);
    },
  });
  pi.registerTool({
    name: "interrupt_agent", label: "Interrupt agent", exposure: "model-only", description: "Stop a child's current turn without deleting its conversation. The child remains available for followup_task.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const run = targetRun(ctx, params.target);
      const running = active.get(run.sessionId);

      if (running) {
        running.controller.abort();
        await running.done;

        return { content: [{ type: "text", text: "Child launch and delegated work stopped." }], details: { sessionId: run.sessionId, completed: true } };
      }

      const data = await interruptSession(run.sessionId, run.hostId, signal);

      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  });

  let stopping: Promise<void> | undefined;
  let detachAbort = () => {};

  const stop = () => {
    if (stopping) return stopping;
    controller.abort();
    mailbox.reset();
    stopping = Promise.allSettled([...pending]).then(() => {
      controller = new AbortController();
      stopping = undefined;
    });

    return stopping;
  };

  const cancel = () => { void stop(); };

  const unsubscribeCancellation = pi.events.on("piop:cancel-preparation", cancel);

  pi.on("agent_start", async (_event, ctx) => {
    await stopping;
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
  pi.on("session_before_switch", stop);
  pi.on("session_shutdown", async () => { detachAbort(); unsubscribeCancellation(); await stop(); });
  pi.registerTool({
    name: "await_subagents", label: "Await all subagents", exposure: "model-only",
    description: "Wait until every pending subagent has finished, successfully or with an error. No parameters, timeout, or early return on input or cancellation. Returns immediately if no subagents are pending. Finish your current run afterward; queued results are delivered in a new turn after the parent agent settles.",
    parameters: Type.Object({}),
    async execute() {
      while (pending.size) await Promise.allSettled([...pending]);

      return { content: [{ type: "text", text: "All subagents have finished. Finish your current run so queued results can be delivered in a new turn." }], details: {} };
    },
  });
  pi.registerTool({
    name: "subagent", label: "Subagents",
    exposure: "model-only",
    description: "Delegate 1–8 independent tasks in the background. Returns child session IDs once created, without waiting for results. Completion or failure starts a new parent turn immediately if idle, or after the parent agent settles. Continue independent work while children run; finish your current run when waiting for mailbox delivery. Call await_subagents to wait until all children finish. Each child has a fresh context, a saved transcript visible in piop, and an explicit worktree choice: same shares files with the caller; new creates a separate Git worktree, copies current changes and runs configured setup. Created worktrees are retained. Supply all necessary context in task. Defaults to the current agent profile and model; agent selects a named piop profile. Resume a finished child with its returned sessionId. Delegation has at most two levels: root → child → grandchild; grandchildren cannot delegate. Avoid overlapping edits. Runs are cancelled when the parent session closes or switches and time out after ten minutes.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), task: Type.String({ minLength: 1, maxLength: 100_000 }), worktree: worktreeChoice, agent: Type.Optional(Type.String({ minLength: 1 })), sessionId: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1, maxItems: 8 }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();

      requireDelegation(ctx);

      if (!params.tasks.length || params.tasks.length > 8 || params.tasks.some((task) => !task.task.trim() || !task.name.trim())) throw new Error("Provide 1–8 named, nonempty tasks");

      if (pending.size + params.tasks.length > 8) throw new Error("At most eight children may run concurrently");
      const resumed = params.tasks.flatMap((task) => task.sessionId ? [task.sessionId] : []);

      if (new Set(resumed).size !== resumed.length) throw new Error("A child can only receive one task at a time");
      const results: SubagentRun[] = [];
      const backgroundSignal = controller.signal;

      const publish = (run: SubagentRun) => {
        if (backgroundSignal.aborted) return;

        if (run.status === "running") { onUpdate?.(subagentPayload(results));

        return; }

        const payload = subagentPayload([run]);
        const notificationId = randomUUID();
        sendAgentMailbox(pi, ctx, { customType: "piop-subagent-result", ...payload, details: { ...payload.details, notificationId }, display: true }, notificationId);
      };

      await Promise.all(params.tasks.map((task) => launchSubagent(task, { pi, ctx, toolCallId, active, results, reportDescendants, signal: backgroundSignal, publish }, pending)));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "wait_agent", "await_subagents"])]);

      return { ...subagentPayload(results), isError: results.some((run) => run.status === "failed" || run.status === "cancelled") };
    },
  });
}
