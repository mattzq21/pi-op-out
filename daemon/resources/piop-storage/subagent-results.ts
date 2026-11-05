import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { call } from "../storage-channel.cjs";
import type { SubagentRun } from "../session-broker/subagent-identity.ts";

export { resultNotificationId } from "../session-broker/subagent-identity.ts";

export { runSchema, type SubagentRun } from "../session-broker/subagent-identity.ts";

// The subagent runs of this chat. The daemon saves them; each call goes through the storage channel.

function sessionFile(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();

  if (!file?.endsWith(".jsonl")) throw new Error("Save the parent conversation before tracking a subagent");

  return file;
}

export function persistSubagentRun(ctx: ExtensionContext, run: SubagentRun) {
  if (run.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Subagent run belongs to another parent conversation");
  const merged = call("subagents.persist", { sessionId: run.parentSessionId, path: sessionFile(ctx), run }) as string[] | null;

  if (merged !== null) run.deliveryIds = merged;
}

export function savedSubagentRuns(ctx: ExtensionContext): SubagentRun[] {
  const file = ctx.sessionManager.getSessionFile();

  return file ? call("subagents.saved", { sessionId: ctx.sessionManager.getSessionId(), path: file }) as SubagentRun[] : [];
}
