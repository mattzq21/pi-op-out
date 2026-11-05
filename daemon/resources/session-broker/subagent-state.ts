import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";
import { currentHost } from "./client.ts";
import { sendAgentMailboxes } from "./orchestration.ts";
import { AUXILIARY_PARENT } from "../piop-storage/index.ts";
import { persistSubagentRun, savedSubagentRuns, runSchema, resultNotificationId, type SubagentRun } from "../agent-records/index.ts";

export { runSchema, type SubagentRun } from "../agent-records/index.ts";


export const SUBAGENT_PARENT = AUXILIARY_PARENT;

const parentSchema = Schema.Object({
  kind: Schema.Literal("subagent"),
  parentSessionId: Schema.String(), sessionId: Schema.Optional(Schema.String()),
  hostId: Schema.Optional(Schema.String()), parentHostId: Schema.Optional(Schema.String()),
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

  for (const run of savedSubagentRuns(ctx)) {
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

function precedes(run: SubagentRun, previous: SubagentRun) {
  const generation = (run.generation ?? 0) - (previous.generation ?? 0);

  return generation < 0 || generation === 0 && run.startedAt < previous.startedAt;
}

export function saveRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  if (ctx.sessionManager.getSessionId() !== run.parentSessionId) throw new Error("The parent conversation changed during subagent supervision");
  const previous = ownedRuns(ctx).find(item => resultNotificationId(item) === resultNotificationId(run));

  if (previous?.resultDelivery === "delivered") run.resultDelivery = "delivered";
  persistSubagentRun(ctx, run);
}

export function subagentPayload(runs: SubagentRun[]): AgentToolResult<{ version: 1; runs: SubagentRun[] }> {
  return { content: [{ type: "text", text: runs.map((run) => `${run.name} (${run.agent ?? "your agent"}): ${run.status}${run.output ? `\n${run.output}` : ""}`).join("\n\n") }], details: { version: 1, runs: structuredClone(runs) } };
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
  };

  pi.on("message_end", (event, ctx) => {
    const message = event.message;

    if (message.role === "custom" && message.customType === "piop-subagent-result" && Check(notificationSchema, message.details)) acknowledge(ctx, message.details.notificationId);
  });

  const flush = (ctx: ExtensionContext) => deliver(ctx, ownedRuns(ctx).filter(run => run.resultDelivery === "pending").map(run => structuredClone(run)));

  pi.on("agent_settled", (_event, ctx) => flush(ctx));

  const notification = (ctx: ExtensionContext, run: SubagentRun) => {
    if (!run.resultNotificationId) {
      run.resultNotificationId = `subagent:${run.parentSessionId}:${run.runId ?? `${run.toolCallId}:${run.startedAt}`}`;
      run.resultDelivery = "pending";
      saveRun(pi, ctx, run);
    }

    return run.resultNotificationId;
  };

  function deliver(ctx: ExtensionContext, runs: SubagentRun[]) {
    const ready = runs.flatMap(run => {
      if (run.status === "running" || run.resultDelivery === "delivered") return [];
      const id = notification(ctx, run);

      if (delivered(ctx, id)) { acknowledge(ctx, id); return []; }

      return outstanding.has(id) ? [] : [{ run, id }];
    });

    if (!ready.length) return;

    if (!ctx.isIdle()) { for (const { id } of ready) pi.events.emit("piop:agent-mail", { notificationId: id, customType: "piop-subagent-result" });

    return; }

    for (const { id } of ready) outstanding.add(id);
    const mail = ready.map(({ run, id }) => {
      const payload = subagentPayload([run]);

      return { message: { customType: "piop-subagent-result", ...payload, details: { ...payload.details, notificationId: id }, display: true }, notificationId: id };
    });

    void sendAgentMailboxes(pi, ctx, mail)
      .then(() => { for (const { id } of ready) if (delivered(ctx, id)) acknowledge(ctx, id); })
      .catch(error => { for (const { id } of ready) outstanding.delete(id); ctx.ui.notify(`Subagent result delivery remains pending: ${(error instanceof Error ? error.message : String(error))}`, "error"); });
  }

  const publish = (ctx: ExtensionContext, run: SubagentRun) => deliver(ctx, [run]);

  const claimable = (ctx: ExtensionContext, run: SubagentRun) => {
    const id = run.resultNotificationId;

    return run.status !== "running" && run.resultDelivery === "pending" && !(id && (outstanding.has(id) || delivered(ctx, id)));
  };

  return {
    reset() { outstanding.clear(); },
    waiting(ctx: ExtensionContext) { return ownedRuns(ctx).some(run => claimable(ctx, run)); },
    claim(ctx: ExtensionContext) {
      const claimed: SubagentRun[] = [];

      for (const run of ownedRuns(ctx)) {
        if (!claimable(ctx, run)) continue;
        run.resultDelivery = "delivered";
        saveRun(pi, ctx, run);
        claimed.push(run);
      }

      return claimed;
    },
    discard(ctx: ExtensionContext, toolCallIds: ReadonlySet<string>) {
      for (const run of ownedRuns(ctx)) {
        if (!toolCallIds.has(run.toolCallId) || run.resultDelivery === "delivered") continue;
        run.resultDelivery = "delivered";
        saveRun(pi, ctx, run);
      }
    },
    publish,
    flush,
  };
}
