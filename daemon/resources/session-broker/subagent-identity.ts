import { createHash } from "node:crypto";
import { Type as Schema, type Static } from "typebox";

const counter = Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const runSchema = Schema.Object({
  version: Schema.Literal(1), toolCallId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), sessionPath: Schema.String(),
  hostId: Schema.String(), name: Schema.String(), task: Schema.String(), status: Schema.Union([Schema.Literal("running"), Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
  startedAt: Schema.Number(), endedAt: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.String()),
  agent: Schema.Optional(Schema.String()), taskPath: Schema.Optional(Schema.String()),
  cwd: Schema.Optional(Schema.String()),
  runId: Schema.Optional(Schema.String()), generation: Schema.Optional(counter),
  observation: Schema.Optional(Schema.Union([Schema.Literal("watching"), Schema.Literal("interrupted")])),
  cancelRequested: Schema.Optional(Schema.Boolean()), cancelReason: Schema.Optional(Schema.String()),
  submission: Schema.Optional(Schema.Union([Schema.Literal("prepared"), Schema.Literal("submitted"), Schema.Literal("accepted")])),
  deliveryIds: Schema.Optional(Schema.Array(Schema.String())), taskNotificationId: Schema.Optional(Schema.String()), taskStartedAt: Schema.Optional(Schema.Number()), activeMs: Schema.Optional(Schema.Number({ minimum: 0 })),
  resultNotificationId: Schema.Optional(Schema.String()), resultDelivery: Schema.Optional(Schema.Union([Schema.Literal("pending"), Schema.Literal("delivered")])),
});

export type SubagentRun = Static<typeof runSchema>;

export function resultNotificationId(run: { parentSessionId: string; sessionId: string; toolCallId: string; startedAt: number }) {
  return `subagent-${createHash("sha256").update(JSON.stringify([run.parentSessionId, run.sessionId, run.toolCallId, run.startedAt])).digest("hex")}`;
}
