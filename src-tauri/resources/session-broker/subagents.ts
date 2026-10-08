import type { AgentToolResult, ExtensionAPI, ExtensionContext, CustomEntryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Parse } from "typebox/value";
import { resolveAgentProfile } from "./agent-profiles.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { currentHost, request } from "./client.ts";
import { createdWorktreeSchema } from "./fork.ts";
import { writeSessionFile } from "./session-file.ts";
import { activeConversation } from "./conversation-location.ts";
import { registerSubagentUsage } from "./subagent-usage.ts";
import type { UsageCheckpoint } from "./subagent-usage.ts";
import { registerSubagentMailbox } from "./subagent-mailbox.ts";
import { interruptSession, sendSessionMessage, sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { SUBAGENT_PARENT, latestRuns, ownedRuns, saveRun, subagentParent, subagentPayload, registerSubagentResults, type SubagentRun } from "./subagent-state.ts";
import { acceptedSubmission, cancelSubagent, drainAccountingRecovery, finishRun, observeSubagent, recoverSubagentAccounting, subagentReceiptSchema, SubagentCancellation, type ActiveSubagent } from "./subagent-reconciliation.ts";
import { accountingUnresolved, resultNotificationId, savedSubagentRuns } from "./subagent-results.ts";
import { boundedRecovery, registerSubagentRecovery } from "./subagent-recovery.ts";

const MAX_DELEGATION_DEPTH = 2;

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

  return { version: 1, toolCallId, parentSessionId, sessionId: previous.sessionId, sessionPath: previous.sessionPath, hostId: previous.hostId,
    name: task.name, task: task.task, status: "running", startedAt: Date.now(), runId: randomUUID(), generation: (previous.generation ?? 0) + 1, submission: "prepared",
    agent: previous.agent, taskPath: previous.taskPath, cwd: previous.cwd, worktree: previous.worktree, branch: previous.branch };
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
  const profile = await resolveAgentProfile(pi, task.agent);
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  let retained = inheritedHistory(ctx, task);
  const workspace = await subagentWorkspace(ctx, task, sessionId, signal);
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId, sessionId, sessionPath, hostId: currentHost(), name: task.name, task: task.task, taskPath: `${scope.taskPath}/${task.name}`, agent: profile.active, status: "running", startedAt: Date.now(), runId: randomUUID(), submission: "prepared", ...workspace };
  let parentId: string | null = null;
  retained = retained.map(item => { const next = { ...item, parentId }; parentId = next.id;

  return next; });

  const entry = (value: CustomEntryDraft | { type: "session_info"; name: string }) => { const id = randomUUID().slice(0, 8); const result = { ...value, id, parentId, timestamp }; parentId = id;

  return result; };

  try { await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: workspace.cwd },
    ...retained,
    entry({ type: "session_info", name: `Subagent: ${task.name}` }),
    entry({ type: "custom", customType: SUBAGENT_PARENT, data: { version: 1, sessionId, hostId: currentHost(), parentSessionId, parentHostId: currentHost(), parentSessionPath: ctx.sessionManager.getSessionFile(), toolCallId, task: task.task, depth: scope.depth + 1, taskPath: run.taskPath, parentTaskPath: scope.taskPath } }),
    entry({ type: "custom", customType: "pi-define-agents-state", data: profile }),
  ], { dependencies: { workspace: { path: workspace.cwd, kind: workspace.worktree === "new" ? "created-worktree" : "existing", branch: workspace.branch } } }); }
  catch (error) { throw new Error(`Subagent session creation failed in ${workspace.cwd}; publication dependencies and any created worktree are retained: ${String(error)}`, { cause: error }); }

  return run;
}

async function deliverFollowup(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun, lifecycle: ActiveSubagent, message: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  lifecycle.controller.signal.throwIfAborted();
  signal?.throwIfAborted();

  if (lifecycle.pendingDeliveries) throw new Error("Wait for this child's outstanding message delivery before sending another task");
  lifecycle.revision++;
  lifecycle.pendingDeliveries++;
  const deliveryId = randomUUID();
  lifecycle.deliveryIds.add(deliveryId);
  const observed = lifecycle.run ?? run;
  observed.deliveryIds = [...lifecycle.deliveryIds];
  observed.task = message;
  observed.taskStartedAt = Date.now();
  observed.submission = "submitted";
  observed.taskNotificationId = undefined;
  saveRun(pi, ctx, observed);

  try {
    const data = await sendSessionMessage(ctx, run.sessionId, run.hostId, message, true, signal, deliveryId);
    acceptedSubmission(observed, Parse(subagentReceiptSchema, data));
    saveRun(pi, ctx, observed);

    return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  } finally { lifecycle.revision++; lifecycle.pendingDeliveries--; }
}

type SubagentExecution = { pi: ExtensionAPI; ctx: ExtensionContext; toolCallId: string; active: Map<string, ActiveSubagent>; results: SubagentRun[]; signal?: AbortSignal; ready: () => void; publish: (run: SubagentRun) => void; reportDescendants: (tokens: number, ctx: ExtensionContext, checkpoint?: UsageCheckpoint) => Promise<void> };

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
    run.accountingPending = true;

    creationIntent(run, signal);
    lifecycle.run = run;
    active.set(run.sessionId, lifecycle); claimed = true;
    saveRun(pi, ctx, run); publish(run);
    execution.ready();
    await observeSubagent(run, { ...execution, signal }, lifecycle, true);
  } catch (error) {
    if (!claimed) { failedCreation(run, signal.aborted, String(error)); }
    else { run.observation = "interrupted"; ctx.ui.notify(`Subagent supervision interrupted: ${String(error)}`, "error"); }
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
  if (task.sessionId) await recoverPreviousRuns(task.sessionId, execution);

  return new Promise<void>((ready) => {
    const completion = executeSubagent(task, { ...execution, ready })
      .catch(error => execution.ctx.ui.notify(`Subagent failed: ${String(error)}`, "error"))
      .finally(() => { ready(); pending.delete(completion); });

    pending.add(completion);
  });
}

async function recoverPreviousRuns(sessionId: string, execution: Omit<SubagentExecution, "ready">) {
  if (execution.active.has(sessionId)) throw new Error("This subagent is already running");

  for (const run of await savedSubagentRuns(execution.ctx)) {
    if (run.sessionId !== sessionId) continue;

    if (run.status === "running") throw new Error("This child's previous task remains unresolved");

    if (accountingUnresolved(run)) await recoverSubagentAccounting(run, { ...execution, ...boundedRecovery(execution) });
  }
}

export function registerSubagents(pi: ExtensionAPI, mailbox = registerSubagentMailbox(pi)) {
  const reportDescendants = registerSubagentUsage(pi);
  const resultsDelivery = registerSubagentResults(pi);
  const active = new Map<string, ActiveSubagent>();
  const pending = new Set<Promise<void>>();
  const accountingJobs = new Map<string, Promise<void>>();
  let controller = new AbortController();
  let context: ExtensionContext | undefined;
  let restoring = Promise.resolve();
  registerSubagentRecovery(pi, { active, ready: () => restoring, stopped: () => controller.signal,
    recover: (run, ctx, scope) => recoverSubagentAccounting(run, { pi, ctx, reportDescendants, ...boundedRecovery(scope) }),
    activate: ctx => restoreSubagents(ctx), publish: async (run, ctx) => { resultsDelivery.publish(ctx, run); } });
  const taskPath = (ctx: ExtensionContext, run: SubagentRun) => run.taskPath ?? `${delegationScope(ctx).taskPath}/${run.name}`;

  const targetRun = (ctx: ExtensionContext, target: string) => {
    const runs = latestRuns(ctx).filter(run => run.sessionId === target || run.name === target || taskPath(ctx, run) === target);

    if (runs.length !== 1) throw new Error("Use a unique child session ID or task name from list_agents");

    return runs[0];
  };

  const start = async (task: SubagentTask, toolCallId: string, ctx: ExtensionContext, signal?: AbortSignal) => {
    signal?.throwIfAborted();

    requireDelegation(ctx);
    reconcile(ctx);

    if (task.sessionId && latestRuns(ctx).some(run => run.sessionId === task.sessionId && run.status === "running")) throw new Error("This child's previous task is unresolved; observe or interrupt it before starting another run");

    if (pending.size - accountingJobs.size >= 8) throw new Error("All eight subagent slots are occupied; wait for a child to finish");

    if (!task.sessionId && latestRuns(ctx).some(run => run.name === task.name)) throw new Error("Task name already exists; use followup_task to reuse the child");
    const results: SubagentRun[] = [];
    const backgroundSignal = controller.signal;
    await launchSubagent(task, { pi, ctx, toolCallId, active, results, reportDescendants, signal: backgroundSignal, publish(run) {
      if (backgroundSignal.aborted || run.status === "running") return;
      resultsDelivery.publish(ctx, run);
    } }, pending);

    return { ...subagentPayload(results), isError: results.some(run => run.status === "failed" || run.status === "cancelled") };
  };

  const unsubscribeTools = pi.events.on("piop:required-tools", ({ ctx, tools, availableTools }) => {
    const allowed = availableTools ?? pi.getActiveTools();
    const child = subagentParent(ctx);

    if (allowed.includes("subagent") || latestRuns(ctx).length) tools.push("spawn_agent", "followup_task", "interrupt_agent", "list_agents", "list_agent_profiles", "send_message", "wait_agent", "await_subagents");

    if (child) tools.push("send_message", "wait_agent");

    if (allowed.includes("send_message")) tools.push("send_message_to_thread", "stop_thread", "read_thread", "wait_threads", "list_threads", "create_thread", "list_agent_profiles");
  });

  pi.on("session_shutdown", unsubscribeTools);
  pi.registerTool({
    name: "spawn_agent", label: "Spawn agent", exposure: "model-only",
    description: "Start one background child and return its session ID and agent profile. Use list_agent_profiles to discover exact agent names. Passing agent uses that profile's prompts, model, effort, tools, skills, extensions and MCP configuration; omitting it inherits the caller's profile and overrides. Profile choice is independent of fork_turns: none (default), all, or a positive number of recent user turns. Up to eight children per parent run concurrently. Delegation has at most two levels: root → child → grandchild; grandchildren cannot delegate. worktree is required: same shares files with the caller; new creates a separate Git worktree, copies current changes and runs configured setup. Created worktrees are retained. Final results arrive in the parent mailbox without starting an idle parent. Use followup_task for more work, send_message for updates, and wait_agent when blocked. Children are cancelled on parent close/switch and time out after ten minutes.",
    parameters: Type.Object({ task_name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), message: Type.String({ minLength: 1, maxLength: 100_000 }), worktree: worktreeChoice, agent: Type.Optional(Type.String({ minLength: 1, description: "Exact configured profile name from list_agent_profiles; omit to inherit the caller" })), fork_turns: Type.Optional(Type.String()) }),
    async execute(id, params, signal, _update, ctx) { return start({ name: params.task_name, task: params.message, agent: params.agent, fork_turns: params.fork_turns, worktree: params.worktree }, id, ctx, signal); },
  });
  pi.registerTool({
    name: "list_agents", label: "List child agents", exposure: "model-only", description: "List this parent's saved child sessions, task paths and current status. Returned paths (such as /root/child/grandchild), local task names and session IDs address children. Independent chats are listed by list_threads.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const agents = await Promise.all(latestRuns(ctx).map(async run => {
        try { const snapshot = await sessionSnapshot(run.sessionId, run.hostId, signal);
        const latest = latestRuns(ctx).find(item => item.sessionId === run.sessionId) ?? run;
        const status = snapshotStatus(snapshot);

        return { sessionId: run.sessionId, task_name: taskPath(ctx, run), agent: run.agent, cwd: run.cwd, worktree: run.worktree, branch: run.branch, status: latest.status === "running" && status === "idle" ? "observing" : status, lastRunStatus: latest.status }; }
        catch (error) { return { sessionId: run.sessionId, task_name: taskPath(ctx, run), cwd: run.cwd, worktree: run.worktree, branch: run.branch, status: "unavailable", error: String(error) }; }
      }));

      return { content: [{ type: "text", text: JSON.stringify(agents) }], details: { agents } };
    },
  });
  pi.registerTool({
    name: "send_message", label: "Message agent", exposure: "model-only", description: "Deliver an update to a child by session ID or task name, or to parent from a child. Steers a running recipient; an idle recipient receives mailbox content without starting a new turn. Use followup_task to wake a child. Returns acceptance, not a reply. Use send_message_to_thread for independent chats.",
    parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1, maxLength: 100_000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const parent = subagentParent(ctx);
      const parentTargets = parent ? ["parent", parent.parentTaskPath ?? "/root", parent.parentSessionId] : [];
      const id = parent && parentTargets.includes(params.target) ? parent.parentSessionId : targetRun(ctx, params.target).sessionId;
      const host = parent && parentTargets.includes(params.target) ? parent.parentHostId ?? currentHost() : targetRun(ctx, params.target).hostId;
      const data = await sendSessionMessage(ctx, id, host, params.message, false, signal);

      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  });
  pi.registerTool({
    name: "followup_task", label: "Follow up with agent", exposure: "model-only", description: "Give an existing child more work. Starts an idle child or steers a running child. Preserves the child's worktree, profile and history. Its final response is delivered through the parent mailbox.",
    parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1, maxLength: 100_000 }) }),
    async execute(id, params, signal, _update, ctx) {
      const run = targetRun(ctx, params.target);
      reconcile(ctx);

      const running = active.get(run.sessionId);

      if (running) {
        await running.ready;

        if (!running.closing) return deliverFollowup(pi, ctx, run, running, params.message, signal);
        await running.done;
      }

      if (latestRuns(ctx).some(item => item.sessionId === run.sessionId && item.status === "running")) throw new Error("This child's previous task remains unresolved; interrupt it before starting another run");

      return start({ name: run.name, task: params.message, sessionId: run.sessionId }, id, ctx, signal);
    },
  });
  pi.registerTool({
    name: "interrupt_agent", label: "Interrupt agent", exposure: "model-only", description: "Stop a child's current turn without deleting its conversation. The child remains available for followup_task.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      reconcile(ctx);
      const run = targetRun(ctx, params.target);
      const running = active.get(run.sessionId);

      if (running) {
        cancelSubagent(pi, ctx, running, "Subagent stopped by interrupt_agent");
        await running.done;

        if (latestRuns(ctx).find(item => item.sessionId === run.sessionId)?.status === "running") throw new Error("Subagent cancellation is not yet confirmed");

        return { content: [{ type: "text", text: "Child launch and delegated work stopped." }], details: { sessionId: run.sessionId, completed: true } };
      }

      run.cancelRequested = true;
      run.cancelReason = "Subagent stopped by interrupt_agent";
      saveRun(pi, ctx, run);
      const data = await interruptSession(run.sessionId, run.hostId, signal);

      if (run.status === "running") { run.status = "cancelled"; finishRun(pi, ctx, run); resultsDelivery.publish(ctx, run); }

      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
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
    mailbox.reset();
    stopping = Promise.allSettled([...pending, drainAccountingRecovery()]).then(() => {
      controller = new AbortController();
      stopping = undefined;
    });

    return stopping;
  };

  const cancel = () => { void stop(); };

  const unsubscribeCancellation = pi.events.on("piop:cancel-preparation", cancel);

  const reconcile = (ctx: ExtensionContext) => {
    context = ctx;

    if (process.env.PIOP_USAGE_RECOVERY === "1") return;
    resultsDelivery.flush(ctx);
    reconcileAccounting(ctx);

    for (const saved of latestRuns(ctx)) {
      if (saved.status !== "running") {
        if (saved.resultDelivery === "pending") resultsDelivery.publish(ctx, structuredClone(saved));
        continue;
      }

      if (active.has(saved.sessionId)) continue;
      const run = structuredClone(saved);
      run.runId ??= `${run.toolCallId}:${run.startedAt}`;
      run.accountingPending = true;

      if (run.submission === "prepared") {
        run.status = run.cancelRequested ? "cancelled" : "failed"; run.output = "The task was not submitted before supervision was interrupted";
        run.accountingPending = false;
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

      const completion = observeSubagent(run, { pi, ctx, reportDescendants, signal }, lifecycle, false)
        .then(() => {
          lifecycle.closing = true; started();

          if (run.status !== "running") { finishRun(pi, ctx, run); resultsDelivery.publish(ctx, run); }
          else { run.observation = "interrupted"; saveRun(pi, ctx, run); }
        })
        .catch(error => ctx.ui.notify(`Subagent supervision interrupted: ${String(error)}`, "error"))
        .finally(() => { lifecycle.closing = true; started(); active.delete(run.sessionId); pending.delete(completion); finished(); });

      pending.add(completion);
    }
  };

  const reconcileAccounting = (ctx: ExtensionContext) => {
    for (const saved of ownedRuns(ctx)) {
      if (saved.status === "running" || !accountingUnresolved(saved)) continue;

      const key = resultNotificationId(saved);

      if (accountingJobs.has(key)) continue;

      const job = recoverSubagentAccounting(structuredClone(saved), { pi, ctx, reportDescendants, ...boundedRecovery({ signal: controller.signal }) })
        .catch(error => ctx.ui.notify(`Saved subagent usage is awaiting reconciliation: ${String(error)}`, "error"))
        .finally(() => { accountingJobs.delete(key); pending.delete(job); });

      accountingJobs.set(key, job); pending.add(job);
    }
  };

  const restoreSubagents = async (ctx: ExtensionContext) => {
    await stopping;
    resultsDelivery.reset();
    const tracked = new Set(ownedRuns(ctx).map(run => JSON.stringify(run)));

    for (const run of await savedSubagentRuns(ctx)) if (!tracked.has(JSON.stringify(run))) saveRun(pi, ctx, run);
    reconcile(ctx);
  };

  pi.on("session_start", (_event, ctx) => restoring = restoreSubagents(ctx).catch(error => ctx.ui.notify(`Subagent restoration remains pending: ${String(error)}`, "error")));

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
  pi.registerTool({
    name: "await_subagents", label: "Await all subagents", exposure: "model-only",
    description: "Wait until every pending subagent has finished, successfully or with an error. No parameters, timeout, or early return on input or cancellation. Returns immediately if no subagents are pending. Subagent results are delivered separately in the conversation.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      reconcile(ctx);

      while (pending.size) { await Promise.allSettled([...pending]); reconcile(ctx); }

      if (latestRuns(ctx).some(run => run.status === "running")) throw new Error("Subagent work remains unresolved; completion has not been confirmed");

      return { content: [{ type: "text", text: "All subagents have finished. Results are delivered separately in the conversation." }], details: {} };
    },
  });
  pi.registerTool({
    name: "subagent", label: "Subagents",
    exposure: "model-only",
    description: "Delegate 1–8 independent tasks in the background. Returns child session IDs once created, without waiting for results. Completion or failure is queued in the parent mailbox and does not start a new parent turn. Continue independent work while children run; call await_subagents to wait until all children finish, or wait_agent to wait for mailbox activity. Each child has a fresh context, a saved transcript visible in piop, and an explicit worktree choice: same shares the caller's directory; new creates a separate Git worktree, copies current changes and runs configured setup. Created worktrees are retained. Supply all necessary context in task. Defaults to the current agent profile and model; agent selects a named piop profile. Resume a finished child with its returned sessionId. Delegation has at most two levels: root → child → grandchild; grandchildren cannot delegate. Avoid overlapping edits. Runs are cancelled when the parent session closes or switches and time out after ten minutes.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), task: Type.String({ minLength: 1, maxLength: 100_000 }), worktree: worktreeChoice, agent: Type.Optional(Type.String({ minLength: 1 })), sessionId: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1, maxItems: 8 }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();

      requireDelegation(ctx);

      if (!params.tasks.length || params.tasks.length > 8 || params.tasks.some((task) => !task.task.trim() || !task.name.trim())) throw new Error("Provide 1–8 named, nonempty tasks");

      reconcile(ctx);

      if (pending.size - accountingJobs.size + params.tasks.length > 8) throw new Error("At most eight children may run concurrently");
      const resumed = params.tasks.flatMap((task) => task.sessionId ? [task.sessionId] : []);

      if (new Set(resumed).size !== resumed.length) throw new Error("A child can only receive one task at a time");
      const results: SubagentRun[] = [];
      const backgroundSignal = controller.signal;

      const publish = (run: SubagentRun) => {
        if (backgroundSignal.aborted) return;

        if (run.status === "running") { onUpdate?.(subagentPayload(results));

        return; }

        resultsDelivery.publish(ctx, run);
      };

      await Promise.all(params.tasks.map((task) => launchSubagent(task, { pi, ctx, toolCallId, active, results, reportDescendants, signal: backgroundSignal, publish }, pending)));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "wait_agent", "await_subagents"])]);

      return { ...subagentPayload(results), isError: results.some((run) => run.status === "failed" || run.status === "cancelled") };
    },
  });
}
