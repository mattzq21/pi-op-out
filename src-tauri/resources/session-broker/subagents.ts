import type { AgentToolResult, ExtensionAPI, ExtensionContext, CustomEntryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import type { SubagentProfileRequest } from "../../../extensions/piop-define-agents/contracts.ts";
import type { GoalScope } from "./goals.ts";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { cancelRequest, currentHost, request } from "./client.ts";
import { writeSessionFile } from "./session-file.ts";
import { goalTokens } from "./goal-state.ts";
import { listenSubagentUsage, registerSubagentUsage } from "./subagent-usage.ts";
import { registerSubagentMailbox } from "./subagent-mailbox.ts";

const SUBAGENT_RUN = "piop-subagent-run";

const SUBAGENT_PARENT = "piop-subagent-parent";

const SUBAGENT_TIMEOUT_MS = 600_000;

type SubagentTask = { task: string; name: string; agent?: string; sessionId?: string };

const runSchema = Schema.Object({
  version: Schema.Literal(1), toolCallId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), sessionPath: Schema.String(),
  hostId: Schema.String(), name: Schema.String(), task: Schema.String(), status: Schema.Union([Schema.Literal("running"), Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
  startedAt: Schema.Number(), endedAt: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.String()), apiCost: Schema.Optional(Schema.Number()),
});

const usageSchema = Schema.Object({ input: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.Number()), cacheWrite: Schema.Optional(Schema.Number()), cost: Schema.Optional(Schema.Object({ total: Schema.Optional(Schema.Number()) })) });

const transcriptEntrySchema = Schema.Object({ type: Schema.String(), usage: Schema.Optional(usageSchema), message: Schema.Optional(Schema.Unknown()) });

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

async function subagentCompletion(run: SubagentRun, offset: number, reportUsage: (tokens: number) => void) {
  let last: SubagentResponse | undefined;
  let cost = 0;
  let tokens = 0;
  const input = createReadStream(run.sessionPath, { start: offset });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      let entry;

      try { entry = JSON.parse(line); } catch { continue; }

      if (!Check(transcriptEntrySchema, entry)) continue;

      if (entry.type !== "message") { tokens += goalTokens(entry.usage); cost += subagentEntryCost(entry.usage); continue; }

      if (!Check(assistantSchema, entry.message)) continue;
      last = entry.message;
      cost += subagentEntryCost(last.usage);
      tokens += goalTokens(last.usage);
    }
  } finally { lines.close(); input.destroy(); reportUsage(tokens); }

  run.apiCost = cost;

  return last;
}

async function createSubagent(pi: ExtensionAPI, ctx: ExtensionContext, task: SubagentTask, toolCallId: string): Promise<SubagentRun> {
  const parentSessionId = ctx.sessionManager.getSessionId();
  const runs = ctx.sessionManager.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RUN ? [Parse(runSchema, entry.data)] : []);

  if (task.sessionId) {
    if (task.agent) throw new Error("A resumed subagent keeps its original agent profile");
    const previous = runs.find((run) => run.parentSessionId === parentSessionId && run.sessionId === task.sessionId && run.hostId === currentHost() && run.sessionPath);

    if (!previous) throw new Error("Only a child created by this conversation can be resumed");

    return { ...previous, toolCallId, name: task.name, task: task.task, status: "running", startedAt: Date.now(), endedAt: undefined, output: undefined, apiCost: undefined };
  }

  const header = ctx.sessionManager.getHeader();

  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before delegating work");
  const profile: SubagentProfileRequest = { agent: task.agent };
  pi.events.emit("piop:agents:subagent", profile);

  if (profile.error) throw new Error(profile.error);

  if (!profile.state) throw new Error("Agent profiles are unavailable");
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId, sessionId, sessionPath, hostId: currentHost(), name: task.name, task: task.task, status: "running", startedAt: Date.now() };
  let parentId: string | null = null;

  const entry = (value: CustomEntryDraft | { type: "session_info"; name: string }) => { const id = randomUUID().slice(0, 8); const result = { ...value, id, parentId, timestamp }; parentId = id;

  return result; };

  await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    entry({ type: "session_info", name: `Subagent: ${task.name}` }),
    entry({ type: "custom", customType: SUBAGENT_PARENT, data: { version: 1, parentSessionId, parentSessionPath: ctx.sessionManager.getSessionFile(), toolCallId, task: task.task } }),
    entry({ type: "custom", customType: "pi-define-agents-state", data: profile.state }),
  ]);

  return run;
}

type SubagentExecution = { pi: ExtensionAPI; ctx: ExtensionContext; toolCallId: string; active: Set<string>; results: SubagentRun[]; signal?: AbortSignal; ready: () => void; publish: (run: SubagentRun) => void };

async function dispatchSubagent(run: SubagentRun, requestId: string, execution: SubagentExecution) {
  const { signal, pi, ctx } = execution;
  signal?.throwIfAborted();
  const offset = (await stat(run.sessionPath)).size;
  const scope: GoalScope = { ctx };
  pi.events.emit("piop:goal-scope", scope);
  await scope.ready;
  let reported = 0;

  const reportUsage = (total: number) => {
    const tokens = Math.max(0, total - reported);
    reported = Math.max(reported, total);

    if (tokens) pi.events.emit("piop:goal-usage", { goalId: scope.goalId, tokens, ctx });
  };

  const usageFailure = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, usageFailure.signal]) : usageFailure.signal;
  const closeUsage = scope.goalId ? await listenSubagentUsage(run.sessionPath, reportUsage, error => { usageFailure.abort(error); void cancelRequest(requestId); }) : async () => {};

  const abort = () => { void cancelRequest(requestId); };

  signal?.addEventListener("abort", abort, { once: true });
  let dispatched = false;
  let last: SubagentResponse | undefined;

  try {
    await request("/message", { hostId: run.hostId, sessionId: run.sessionId, message: run.task, requestId, deadline: Date.now() + SUBAGENT_TIMEOUT_MS }, requestSignal, SUBAGENT_TIMEOUT_MS);
    dispatched = true;
  } catch (error) { await cancelRequest(requestId); throw error; }
  finally {
    signal?.removeEventListener("abort", abort);

    try { await closeUsage(); last = await subagentCompletion(run, offset, reportUsage); }
    catch (error) { if (dispatched) throw error; }
  }

  run.output = completedSubagentOutput(last);
  run.status = "completed";
}

async function executeSubagent(task: SubagentTask, execution: SubagentExecution) {
  const { pi, ctx, toolCallId, active, results, signal, publish } = execution;
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId: ctx.sessionManager.getSessionId(), sessionId: task.sessionId ?? "", sessionPath: "", hostId: currentHost(), name: task.name, task: task.task, status: "running", startedAt: Date.now() };
  results.push(run);
  let claimed = false;

  try {
    signal?.throwIfAborted();
    const child = await createSubagent(pi, ctx, task, toolCallId);

    if (active.has(child.sessionId)) throw new Error("This subagent is already running");
    Object.assign(run, child);
    active.add(run.sessionId); claimed = true;
    pi.appendEntry(SUBAGENT_RUN, { ...run }); publish(run);
    execution.ready();
    await dispatchSubagent(run, randomUUID(), execution);
  } catch (error) {
    run.status = signal?.aborted ? "cancelled" : "failed";
    run.output = error instanceof Error ? error.message : String(error);
  }

  if (claimed) active.delete(run.sessionId);
  run.endedAt = Date.now();
  pi.appendEntry(SUBAGENT_RUN, { ...run }); publish(run);
}

function subagentPayload(runs: SubagentRun[]): AgentToolResult<{ version: 1; runs: SubagentRun[] }> {
  return { content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.status}\nSession: ${run.hostId}/${run.sessionId}\nTranscript: ${run.sessionPath}${run.output ? `\n${run.output}` : ""}`).join("\n\n") }], details: { version: 1, runs: structuredClone(runs) } };
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
  registerSubagentUsage(pi);
  const mailbox = registerSubagentMailbox(pi);
  const active = new Set<string>();
  const pending = new Set<Promise<void>>();
  let controller = new AbortController();

  const stop = async () => {
    controller.abort();
    mailbox.reset();
    await Promise.allSettled([...pending]);
    controller = new AbortController();
  };

  pi.on("session_before_switch", stop);
  pi.on("session_shutdown", stop);
  pi.registerTool({
    name: "await_subagents", label: "Await all subagents", exposure: "model-only",
    description: "Wait until every pending subagent has finished, successfully or with an error. No parameters, timeout, or early return on input or cancellation. Returns immediately if no subagents are pending. Subagent results are delivered separately in the conversation.",
    parameters: Type.Object({}),
    async execute() {
      while (pending.size) await Promise.allSettled([...pending]);

      return { content: [{ type: "text", text: "All subagents have finished. Results are delivered separately in the conversation." }], details: {} };
    },
  });
  pi.registerTool({
    name: "subagent", label: "Subagents",
    exposure: "model-only",
    description: "Delegate 1–4 independent tasks in the background. Returns child session IDs once created, without waiting for results. Completion or failure is queued in the parent mailbox and does not start a new parent turn. Continue independent work while children run; call await_subagents to wait until all children finish, or wait_agent to wait for mailbox activity. Each child has a fresh context, a saved transcript visible in piop, and the current working directory (files are shared). Supply all necessary context in task. Defaults to the current agent profile and model; agent selects a named piop profile. Resume a finished child with its returned sessionId. Child agents cannot delegate further. Avoid overlapping edits. Runs are cancelled when the parent session closes or switches and time out after ten minutes.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), task: Type.String({ minLength: 1, maxLength: 100_000 }), agent: Type.Optional(Type.String({ minLength: 1 })), sessionId: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1, maxItems: 4 }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();

      if (ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_PARENT)) throw new Error("Subagents cannot delegate further; return your findings to the parent");

      if (!params.tasks.length || params.tasks.length > 4 || params.tasks.some((task) => !task.task.trim() || !task.name.trim())) throw new Error("Provide 1–4 named, nonempty tasks");
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
        pi.sendMessage({ customType: "piop-subagent-result", ...payload, details: { ...payload.details, notificationId }, display: true }, { triggerTurn: false, deliverAs: "steer" });
        mailbox.notify(notificationId);
      };

      await Promise.all(params.tasks.map((task) => launchSubagent(task, { pi, ctx, toolCallId, active, results, signal: backgroundSignal, publish }, pending)));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "wait_agent", "await_subagents"])]);

      return { ...subagentPayload(results), isError: results.some((run) => run.status === "failed" || run.status === "cancelled") };
    },
  });
}
