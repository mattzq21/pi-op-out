import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "./client.ts";
import { sessionSnapshot, snapshotStatus } from "./orchestration.ts";
import { accountingUnresolved, persistSubagentRun, resultNotificationId, savedSubagentRuns, unresolvedSubagentRuns, type SubagentRun } from "./subagent-results.ts";
import { subagentParent } from "./subagent-state.ts";

export interface RecoveryScope { signal?: AbortSignal; recoveryDepth?: number; recoveryDeadline?: number }

const recoverySchema = Type.Object({ sourceSessionId: Type.String(), recoveryDepth: Type.Integer({ minimum: 1, maximum: 2 }), deadline: Type.Integer({ minimum: 1 }) });

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

export async function waitForAccounting(done: Promise<void>, scope: RecoveryScope & { signal: AbortSignal; recoveryDeadline: number }) {
  const cancellation = new AbortController();

  try {
    await Promise.race([done, delay(Math.max(0, scope.recoveryDeadline - Date.now()), undefined, { signal: AbortSignal.any([scope.signal, cancellation.signal]) }).then(() => { throw new Error("Subagent accounting recovery timed out"); })]);
  } finally { cancellation.abort(); }
}

export async function recoverStoppedRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun, scope: RecoveryScope) {
  if (run.status !== "running") return;
  const snapshot = await sessionSnapshot(run.sessionId, run.hostId, scope.signal);
  scope.signal?.throwIfAborted();

  if (!["idle", "paused"].includes(snapshotStatus(snapshot))) throw new Error(`Subagent ${run.name} is still running`);
  run.status = "cancelled";
  run.accountingPending = true;
  run.endedAt = Date.now();
  run.output = "The previous observer stopped before this child's usage was reconciled.";
  await persistSubagentRun(pi, ctx, run);
}

function authorizeRecovery(ctx: ExtensionContext, source: string) {
  if (ctx.mode !== "rpc" || subagentParent(ctx)?.parentSessionId !== source) throw new Error("Only the parent conversation can recover delegated usage");
}

interface RecoveryRuntime {
  active: Map<string, { done: Promise<void> }>;
  stopped: () => AbortSignal;
  recover: (run: SubagentRun, ctx: ExtensionContext, scope: RecoveryScope) => Promise<void>;
  activate: (ctx: ExtensionContext) => Promise<void>;
  publish: (run: SubagentRun, ctx: ExtensionContext) => Promise<void>;
  ready?: () => Promise<void>;
}

async function retryAccountingPass(ctx: ExtensionContext, runtime: RecoveryRuntime, signal: AbortSignal, reported: Set<string>) {
  await runtime.ready?.();

  for (const run of await savedSubagentRuns(ctx)) {
    if (!accountingUnresolved(run) || runtime.active.has(run.sessionId)) continue;
    signal.throwIfAborted();

    try {
      const scope = boundedRecovery({ signal });
      await runtime.recover(run, ctx, scope);
      await runtime.publish(run, ctx);
      reported.delete(resultNotificationId(run));
    } catch (error) {
      signal.throwIfAborted();

      if (!reported.has(resultNotificationId(run))) ctx.ui.notify(`Token usage recovery will retry for ${run.name}: ${(error instanceof Error ? error.message : String(error))}`, "error");
      reported.add(resultNotificationId(run));
    }
  }
}

async function retryPendingAccounting(ctx: ExtensionContext, runtime: RecoveryRuntime, signal: AbortSignal) {
  const reported = new Set<string>();
  let pause = 1000;

  while (!signal.aborted) {
    await delay(pause, undefined, { signal });
    pause = Math.min(30_000, pause * 2);

    try { await retryAccountingPass(ctx, runtime, signal, reported); reported.delete("inventory"); }
    catch (error) {
      signal.throwIfAborted();

      if (!reported.has("inventory")) ctx.ui.notify(`Token usage recovery will retry reading saved runs: ${(error instanceof Error ? error.message : String(error))}`, "error");
      reported.add("inventory");
    }
  }
}

export function registerSubagentRecovery(pi: ExtensionAPI, runtime: RecoveryRuntime) {
  const { active, stopped, recover } = runtime;
  let pending = Promise.resolve();
  let operations = new AbortController();
  let retryController = new AbortController();
  let retrying = Promise.resolve();

  const stopRetries = async () => { retryController.abort(); await retrying; };

  const startRetries = async (ctx: ExtensionContext) => {
    await stopRetries();

    if (process.env.PIOP_USAGE_RECOVERY === "1") return;
    retryController = new AbortController();
    const signal = retryController.signal;
    retrying = retryPendingAccounting(ctx, runtime, signal).catch(error => { if (!signal.aborted) ctx.ui.notify(`Token usage recovery remains pending: ${(error instanceof Error ? error.message : String(error))}`, "error"); });
  };

  const unsubscribe = pi.events.on("piop:rpc", event => {
    if (event.command === "activate_usage_recovery") {
      event.ready = pending.then(async () => {
        if (process.env.PIOP_USAGE_RECOVERY !== "1") return;
        delete process.env.PIOP_USAGE_RECOVERY;
        await runtime.activate(event.ctx);
        await startRetries(event.ctx);
        pi.events.emit("piop:agents:ready", { ctx: event.ctx });
      });
      pending = event.ready.then(() => {}, () => {});

      return;
    }

    if (event.command !== "recover_subagent_usage") return;
    const payload = Parse(recoverySchema, event.payload);
    authorizeRecovery(event.ctx, payload.sourceSessionId);
    const scope = boundedRecovery({ signal: AbortSignal.any([operations.signal, stopped()]), recoveryDepth: payload.recoveryDepth, recoveryDeadline: payload.deadline });
    event.ready = pending.then(async () => {
      for (let run of await savedSubagentRuns(event.ctx)) {
        scope.signal.throwIfAborted();
        const observer = active.get(run.sessionId);

        if (observer) {
          await waitForAccounting(observer.done, scope);
          run = (await savedSubagentRuns(event.ctx)).find(saved => resultNotificationId(saved) === resultNotificationId(run)) ?? run;
        }

        if (accountingUnresolved(run)) await recover(run, event.ctx, scope);
      }

      return { complete: true };
    });
    pending = event.ready.then(() => {}, () => {});
  });

  const stopRecovery = async () => { operations.abort(); await stopRetries(); await pending; };

  pi.on("session_start", (_event, ctx) => { operations = new AbortController();

  return startRetries(ctx); });
  pi.on("agent_start", (_event, ctx) => startRetries(ctx));
  pi.on("session_before_switch", stopRecovery);
  pi.on("session_shutdown", async () => { unsubscribe(); await stopRecovery(); });
}
