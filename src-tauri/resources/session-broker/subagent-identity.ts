import { createHash } from "node:crypto";

export function resultNotificationId(run: { parentSessionId: string; sessionId: string; toolCallId: string; startedAt: number }) {
  return `subagent-${createHash("sha256").update(JSON.stringify([run.parentSessionId, run.sessionId, run.toolCallId, run.startedAt])).digest("hex")}`;
}
