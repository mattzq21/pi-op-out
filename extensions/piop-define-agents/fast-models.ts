import { z } from "zod";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FastModelSnapshot } from "../../daemon/src/host/fast_models.ts";
import type { FastModeSession, FastModeSessionRequest } from "../piop-openai-fast-mode/src/types.ts";

export type { FastModelSnapshot };

const snapshotSchema = z.object({
  ready: z.boolean(),
  providers: z.record(z.string(), z.object({ supportedModelIds: z.array(z.string()), error: z.string().optional() })),
  error: z.string().optional(),
});

export function parseFastModelSnapshot(value: unknown): FastModelSnapshot | null {
  return value === null || value === undefined ? null : snapshotSchema.parse(value);
}

/**
 * Checks an agent that turns fast mode on against the host's fast model results.
 * Returns undefined when the model is supported or when the host cannot confirm it yet.
 */
export function fastModelProblem(snapshot: FastModelSnapshot | null, agent: string, model: string | undefined): string | undefined {
  if (!model) return 'Agent "' + agent + '" cannot enable fast mode because it has no model';

  if (!snapshot?.ready) return undefined;
  const [provider, ...parts] = model.split("/");
  const saved = snapshot.providers[provider];

  if (saved?.supportedModelIds.includes(parts.join("/")) || saved?.error) return undefined;

  return 'Agent "' + agent + '" cannot enable fast mode because model ' + model + " does not support it";
}

/** Reads the host's fast model results through the daemon. Returns null outside piop. */
export async function hostFastModels(): Promise<FastModelSnapshot | null> {
  const broker = process.env.PI_DESKTOP_BROKER_URL;
  const token = process.env.PI_DESKTOP_BROKER_TOKEN;

  if (!broker || !token) return null;
  const response = await fetch(broker + "/fast-models", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ hostId: process.env.PI_DESKTOP_HOST_ID || "local" }), signal: AbortSignal.timeout(30_000),
  });
  const body = z.object({ data: z.unknown().optional(), error: z.string().optional() }).parse(await response.json());

  if (!response.ok || body.error) throw new Error("Could not read fast models from the host: " + (body.error ?? "HTTP " + response.status));

  return parseFastModelSnapshot(body.data);
}

/** The fast mode extension's session interface, or undefined when the extension is not loaded. */
export function fastModeSession(pi: ExtensionAPI): FastModeSession | undefined {
  const request: FastModeSessionRequest = {};
  pi.events.emit("piop:fast-mode:session", request);

  return request.session;
}
