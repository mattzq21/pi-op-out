import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema, type Static } from "typebox";
import { Check } from "typebox/value";
import { currentHost } from "./client.ts";
import { sendAgentMailbox } from "./orchestration.ts";

export const SUBAGENT_RUN = "piop-subagent-run";

export const SUBAGENT_PARENT = "piop-subagent-parent";

const counter = Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const parentSchema = Schema.Object({
  parentSessionId: Schema.String(), sessionId: Schema.Optional(Schema.String()), depth: Schema.Optional(Schema.Integer({ minimum: 1 })),
  hostId: Schema.Optional(Schema.String()), parentHostId: Schema.Optional(Schema.String()),
  taskPath: Schema.Optional(Schema.String()), parentTaskPath: Schema.Optional(Schema.String()),
});

export const runSchema = Schema.Object({
  version: Schema.Literal(1), toolCallId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), sessionPath: Schema.String(),
  hostId: Schema.String(), name: Schema.String(), task: Schema.String(), status: Schema.Union([Schema.Literal("running"), Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
  startedAt: Schema.Number(), endedAt: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.String()), apiCost: Schema.Optional(Schema.Number()),
  agent: Schema.Optional(Schema.String()), taskPath: Schema.Optional(Schema.String()),
  cwd: Schema.Optional(Schema.String()), worktree: Schema.Optional(Schema.Union([Schema.Literal("same"), Schema.Literal("new")])), branch: Schema.Optional(Schema.String()),
  runId: Schema.Optional(Schema.String()), generation: Schema.Optional(counter), offset: Schema.Optional(counter), accountedTokens: Schema.Optional(counter), forwardedTokens: Schema.Optional(counter),
  offsetHeader: Schema.Optional(Schema.String()), usageBoundaryId: Schema.Optional(Schema.String()), usageNotificationId: Schema.Optional(Schema.String()),
  goalId: Schema.Optional(Schema.String()), goalTokens: Schema.Optional(counter),
  sourceTotals: Schema.Optional(Schema.Record(Schema.String(), counter)), legacyCredits: Schema.Optional(counter),
  observation: Schema.Optional(Schema.Union([Schema.Literal("watching"), Schema.Literal("interrupted")])),
  cancelRequested: Schema.Optional(Schema.Boolean()), cancelReason: Schema.Optional(Schema.String()),
  submission: Schema.Optional(Schema.Union([Schema.Literal("prepared"), Schema.Literal("submitted"), Schema.Literal("accepted")])),
  deliveryIds: Schema.Optional(Schema.Array(Schema.String())), taskNotificationId: Schema.Optional(Schema.String()), taskStartedAt: Schema.Optional(Schema.Number()),
  resultNotificationId: Schema.Optional(Schema.String()), resultDelivery: Schema.Optional(Schema.Union([Schema.Literal("pending"), Schema.Literal("delivered")])),
});

export type SubagentRun = Static<typeof runSchema>;

export function subagentParent(ctx: ExtensionContext) {
  const id = ctx.sessionManager.getSessionId();
  const parents = ctx.sessionManager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === SUBAGENT_PARENT && Check(parentSchema, entry.data) ? [entry.data] : []);
  const own = parents.findLast(parent => parent.sessionId === id);

  if (own) return own;

  if (ctx.sessionManager.getHeader()?.parentSession) return;

  return parents.findLast(parent => parent.sessionId === undefined);
}

export function ownedRuns(ctx: ExtensionContext) {
  const runs = new Map<string, SubagentRun>();

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_RUN || !Check(runSchema, entry.data)) continue;
    const run = entry.data;

    if (run.parentSessionId !== ctx.sessionManager.getSessionId() || run.hostId !== currentHost()) continue;

    if (!run.sessionId || !run.sessionPath) continue;
    runs.set(`${run.sessionId}:${run.runId ?? `${run.toolCallId}:${run.startedAt}`}`, run);
  }

  return [...runs.values()];
}

export function latestRuns(ctx: ExtensionContext) {
  const runs = new Map<string, SubagentRun>();

  for (const run of ownedRuns(ctx)) {
    const previous = runs.get(run.sessionId);

    if (previous && precedes(run, previous)) continue;
    runs.set(run.sessionId, run);
  }

  return [...runs.values()];
}

export function originalRunTask(ctx: ExtensionContext, run: SubagentRun) {
  const key = run.runId ?? `${run.toolCallId}:${run.startedAt}`;

  const entry = ctx.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === SUBAGENT_RUN && Check(runSchema, entry.data)
    && entry.data.parentSessionId === run.parentSessionId && entry.data.sessionId === run.sessionId && (entry.data.runId ?? `${entry.data.toolCallId}:${entry.data.startedAt}`) === key);

  return entry?.type === "custom" && Check(runSchema, entry.data) ? entry.data.task : run.task;
}

function precedes(run: SubagentRun, previous: SubagentRun) {
  const generation = (run.generation ?? 0) - (previous.generation ?? 0);

  return generation < 0 || generation === 0 && run.startedAt < previous.startedAt;
}

export function saveRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  if (ctx.sessionManager.getSessionId() !== run.parentSessionId) throw new Error("The parent conversation changed during subagent supervision");
  const previous = ownedRuns(ctx).find(item => item.runId === run.runId && item.sessionId === run.sessionId);

  if (previous?.resultDelivery === "delivered") run.resultDelivery = "delivered";
  pi.appendEntry(SUBAGENT_RUN, structuredClone(run));
}

export function subagentPayload(runs: SubagentRun[]): AgentToolResult<{ version: 1; runs: SubagentRun[] }> {
  return { content: [{ type: "text", text: runs.map((run) => `${run.name}: ${run.status}\nAgent profile: ${run.agent ?? "original profile"}\nSession: ${run.hostId}/${run.sessionId}\nWorkspace: ${run.cwd ?? "original working directory"} (${run.worktree ?? "same"})${run.branch ? `\nBranch: ${run.branch}` : ""}\nTranscript: ${run.sessionPath}${run.output ? `\n${run.output}` : ""}`).join("\n\n") }], details: { version: 1, runs: structuredClone(runs) } };
}

const notificationSchema = Schema.Object({ notificationId: Schema.String() });

export function registerSubagentResults(pi: ExtensionAPI) {
  const outstanding = new Set<string>();

  const delivered = (ctx: ExtensionContext, id: string) => ctx.sessionManager.getEntries().some(entry => entry.type === "custom_message"
    && entry.customType === "piop-subagent-result" && Check(notificationSchema, entry.details) && entry.details.notificationId === id);

  const acknowledge = (ctx: ExtensionContext, id: string) => {
    outstanding.delete(id);
    const run = ownedRuns(ctx).find(item => item.resultNotificationId === id);

    if (!run || run.resultDelivery === "delivered") return;
    saveRun(pi, ctx, { ...run, resultDelivery: "delivered" });
  };

  pi.on("message_end", (event, ctx) => {
    const message = event.message;

    if (message.role === "custom" && message.customType === "piop-subagent-result" && Check(notificationSchema, message.details)) acknowledge(ctx, message.details.notificationId);
  });

  const flush = (ctx: ExtensionContext, boundary: boolean) => {
    for (const run of ownedRuns(ctx)) if (run.resultDelivery === "pending") publish(ctx, structuredClone(run), boundary);
  };

  pi.on("turn_end", (_event, ctx) => flush(ctx, true));
  pi.on("agent_settled", (_event, ctx) => flush(ctx, false));

  const notification = (ctx: ExtensionContext, run: SubagentRun) => {
    if (!run.resultNotificationId) {
      run.resultNotificationId = `subagent:${run.parentSessionId}:${run.runId ?? `${run.toolCallId}:${run.startedAt}`}`;
      run.resultDelivery = "pending";
      saveRun(pi, ctx, run);
    }

    return run.resultNotificationId;
  };

  const publish = (ctx: ExtensionContext, run: SubagentRun, boundary = false) => {
    if (run.status === "running" || run.resultDelivery === "delivered") return;
    const id = notification(ctx, run);

    if (delivered(ctx, id)) { acknowledge(ctx, id);

    return; }

    if (outstanding.has(id)) return;

    if (!boundary && !ctx.isIdle()) { pi.events.emit("piop:agent-mail", { notificationId: id });

    return; }

    outstanding.add(id);

    const payload = subagentPayload([run]);

    try { sendAgentMailbox(pi, { customType: "piop-subagent-result", ...payload, details: { ...payload.details, notificationId: id }, display: true }, id); }
    catch (error) { outstanding.delete(id); throw error; }
  };

  return {
    reset() { outstanding.clear(); },
    publish,
    flush(ctx: ExtensionContext) { flush(ctx, false); },
  };
}
