import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";
import { currentHost } from "./client.ts";
import { sendAgentMailbox } from "./orchestration.ts";
import { persistSubagentRun, forgetSubagentRun } from "./subagent-results.ts";
import { runSchema, resultNotificationId, type SubagentRun } from "./subagent-identity.ts";

export { runSchema, type SubagentRun } from "./subagent-identity.ts";

export const SUBAGENT_RUN = "piop-subagent-run";

export const SUBAGENT_PARENT = "piop-subagent-parent";

const parentSchema = Schema.Object({
  parentSessionId: Schema.String(), sessionId: Schema.Optional(Schema.String()), depth: Schema.Optional(Schema.Integer({ minimum: 1 })),
  hostId: Schema.Optional(Schema.String()), parentHostId: Schema.Optional(Schema.String()),
  taskPath: Schema.Optional(Schema.String()), parentTaskPath: Schema.Optional(Schema.String()),
});

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
    runs.set(`${run.sessionId}:${run.runId ?? `${run.toolCallId}:${run.startedAt}`}`, structuredClone(run));
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
  const previous = ownedRuns(ctx).find(item => resultNotificationId(item) === resultNotificationId(run));

  if (previous?.resultDelivery === "delivered") run.resultDelivery = "delivered";
  persistSubagentRun(pi, ctx, run);
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
    run.resultDelivery = "delivered";
    saveRun(pi, ctx, run);

    if (!run.accountingPending) void forgetSubagentRun(ctx, run).catch(error => ctx.ui.notify(`Subagent journal cleanup remains pending: ${String(error)}`, "error"));
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

    void sendAgentMailbox(pi, ctx, { customType: "piop-subagent-result", ...payload, details: { ...payload.details, notificationId: id }, display: true }, id)
      .then(() => { if (delivered(ctx, id)) acknowledge(ctx, id); })
      .catch(error => { outstanding.delete(id); ctx.ui.notify(`Subagent result delivery remains pending: ${String(error)}`, "error"); });
  };

  return {
    reset() { outstanding.clear(); },
    publish,
    flush(ctx: ExtensionContext) { flush(ctx, false); },
  };
}
