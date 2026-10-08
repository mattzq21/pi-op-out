import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "./client.ts";
import { sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { forgetSubagentRun, hasSubagentResult, persistSubagentRun, resultNotificationId, savedSubagentRuns, unresolvedSubagentRuns, type SubagentRun } from "./subagent-results.ts";

export interface RecoveryScope { signal?: AbortSignal; recoveryDepth?: number; recoveryDeadline?: number }

const recoverySchema = Type.Object({ sourceSessionId: Type.String(), recoveryDepth: Type.Integer({ minimum: 1, maximum: 2 }), deadline: Type.Integer({ minimum: 1 }) });

const parentSchema = Type.Object({ parentSessionId: Type.String() });

export function boundedRecovery(scope: RecoveryScope): RecoveryScope & { signal: AbortSignal; recoveryDeadline: number } {
  const recoveryDeadline = Math.min(scope.recoveryDeadline ?? Infinity, Date.now() + 30_000);
  const timeout = AbortSignal.timeout(Math.max(0, recoveryDeadline - Date.now()));
  const signal = scope.signal ? AbortSignal.any([scope.signal, timeout]) : timeout;

  return { ...scope, signal, recoveryDeadline };
}

export async function recoverDescendantAccounting(run: SubagentRun, scope: RecoveryScope) {
  if (!(await unresolvedSubagentRuns(run.sessionPath, run.sessionId)).length) return;
  const bounded = boundedRecovery(scope);
  bounded.signal.throwIfAborted();
  const recoveryDepth = (scope.recoveryDepth ?? 0) + 1;

  if (recoveryDepth > 2) throw new Error("Subagent accounting ancestry exceeds the delegation limit");

  const result = await request("/orchestration", {
    action: "recover_usage", sessionId: run.sessionId, hostId: run.hostId, sourceSessionId: run.parentSessionId,
    recoveryDepth, deadline: bounded.recoveryDeadline,
  }, bounded.signal, Math.max(1, bounded.recoveryDeadline - Date.now()));

  if (!Check(Type.Object({ complete: Type.Literal(true) }), result)) throw new Error(`Descendant accounting is still active for ${run.name}; recovery remains saved`);
}

async function waitForObserver(done: Promise<void>, scope: RecoveryScope & { signal: AbortSignal; recoveryDeadline: number }) {
  const cancellation = new AbortController();

  try {
    await Promise.race([done, delay(Math.max(0, scope.recoveryDeadline - Date.now()), undefined, { signal: AbortSignal.any([scope.signal, cancellation.signal]) }).then(() => { throw new Error("Subagent accounting recovery timed out"); })]);
  } finally { cancellation.abort(); }
}

async function recoverStoppedRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun, scope: RecoveryScope) {
  if (run.status !== "running") return;
  const snapshot = await sessionSnapshot(run.sessionId, run.hostId, scope.signal);

  if (!["idle", "paused"].includes(snapshotStatus(snapshot))) throw new Error(`Subagent ${run.name} is still running`);
  run.status = "cancelled";
  run.accountingPending = true;
  run.endedAt = Date.now();
  run.output = "The previous observer stopped before this child's usage was reconciled.";
  await persistSubagentRun(pi, ctx, run);
}

function authorizeRecovery(ctx: ExtensionContext, source: string) {
  const entry = ctx.sessionManager.getEntries().find(item => item.type === "custom" && item.customType === "piop-subagent-parent");

  if (ctx.mode !== "rpc" || entry?.type !== "custom" || !Check(parentSchema, entry.data) || entry.data.parentSessionId !== source) throw new Error("Only the parent conversation can recover delegated usage");
}

export function registerSubagentRecovery(pi: ExtensionAPI, active: Map<string, { done: Promise<void> }>, stopped: () => AbortSignal, recover: (run: SubagentRun, ctx: ExtensionContext, scope: RecoveryScope) => Promise<void>) {
  let pending = Promise.resolve();

  const unsubscribe = pi.events.on("piop:rpc", event => {
    if (event.command !== "recover_subagent_usage") return;
    const payload = Parse(recoverySchema, event.payload);
    authorizeRecovery(event.ctx, payload.sourceSessionId);
    const scope = boundedRecovery({ signal: stopped(), recoveryDepth: payload.recoveryDepth, recoveryDeadline: payload.deadline });
    event.ready = pending.then(async () => {
      for (let run of await savedSubagentRuns(event.ctx)) {
        scope.signal.throwIfAborted();
        const observer = active.get(run.sessionId);

        if (observer) {
          await waitForObserver(observer.done, scope);
          run = (await savedSubagentRuns(event.ctx)).find(saved => resultNotificationId(saved) === resultNotificationId(run)) ?? run;
        }

        await recoverStoppedRun(pi, event.ctx, run, scope);

        if (run.accountingPending) await recover(run, event.ctx, scope);

        if (hasSubagentResult(event.ctx, run)) await forgetSubagentRun(event.ctx, run);
      }

      return { complete: true };
    });
    pending = event.ready.then(() => {}, () => {});
  });

  pi.on("session_shutdown", unsubscribe);
}
