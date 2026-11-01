import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FastModelSnapshot } from "../../daemon/src/host/fast_models.ts";
import type { FastModeSession, FastModeSessionRequest } from "../piop-openai-fast-mode/src/types.ts";

export type { FastModelSnapshot };

const snapshotSchema = Type.Object({
  ready: Type.Boolean(),
  providers: Type.Record(Type.String(), Type.Object({ supportedModelIds: Type.Array(Type.String()), error: Type.Optional(Type.String()) })),
  error: Type.Optional(Type.String()),
});

export function parseFastModelSnapshot(value: unknown): FastModelSnapshot | null {
  return value === null || value === undefined ? null : Parse(snapshotSchema, value);
}

export function fastModelProblem(snapshot: FastModelSnapshot | null, agent: string, model: string | undefined): string | undefined {
  if (!model) return 'Agent "' + agent + '" cannot enable fast mode because it has no model';

  if (!snapshot?.ready) return undefined;
  const [provider, ...parts] = model.split("/");
  const saved = snapshot.providers[provider];

  if (saved?.supportedModelIds.includes(parts.join("/")) || saved?.error) return undefined;

  return 'Agent "' + agent + '" cannot enable fast mode because model ' + model + " does not support it";
}

export async function hostFastModels(): Promise<FastModelSnapshot | null> {
  const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as ((name: string, data: unknown) => Promise<unknown>) | undefined;

  if (!send) return null;
  const answer = Parse(Type.Union([Type.Object({ data: Type.Unknown() }), Type.Object({ error: Type.String() })]), await send("broker", { path: "/fast-models", body: { hostId: process.env.PI_DESKTOP_HOST_ID || "local" } }));

  if ("error" in answer) throw new Error("Could not read fast models from the host: " + answer.error);

  return parseFastModelSnapshot(answer.data);
}

export function fastModeSession(pi: ExtensionAPI): FastModeSession | undefined {
  const request: FastModeSessionRequest = {};
  pi.events.emit("piop:fast-mode:session", request);

  return request.session;
}
