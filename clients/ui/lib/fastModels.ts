import { backgroundAttempt } from "./backgroundErrors";
import { createSignal, type Accessor, type Setter } from "solid-js";
import { z } from "zod";
import { invoke, listen } from "./platform";

const snapshotSchema = z.object({
  ready: z.boolean(),
  providers: z.record(z.string(), z.object({ supportedModelIds: z.array(z.string()), error: z.string().optional() })),
  error: z.string().optional(),
});

export type FastModelSnapshot = z.infer<typeof snapshotSchema>;

const hosts = new Map<string, { snapshot: Accessor<FastModelSnapshot | undefined>; set: Setter<FastModelSnapshot | undefined> }>();

const failed = new Set<string>();

let watching = false;

function load(hostId: string) {
  const entry = hosts.get(hostId);

  if (!entry) return;
  const attempt = backgroundAttempt(`fast-models:${hostId}`, "Could not load fast models for host " + hostId);
  void invoke("provider_auth", { hostId, request: { action: "fast_models" } }, snapshotSchema)
    .then(snapshot => { if (attempt.succeeded()) failed.delete(hostId); entry.set(snapshot); }, reason => { if (attempt.failed(reason)) failed.add(hostId); });
}

export function hostFastModels(hostId: string): Accessor<FastModelSnapshot | undefined> {
  if (!watching) {
    watching = true;
    void listen("pi://fast-models-changed", ({ payload }) => load(payload.hostId), z.object({ hostId: z.string() }));
    void listen("pi://event", ({ payload }) => { if (payload.type === "connection_restored") for (const hostId of [...failed]) load(hostId); }, z.object({ type: z.string().optional() }).catch({}));
  }

  let entry = hosts.get(hostId);

  if (!entry) {
    const [snapshot, set] = createSignal<FastModelSnapshot | undefined>(undefined, { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) });
    entry = { snapshot, set };
    hosts.set(hostId, entry);
    load(hostId);
  }

  return entry.snapshot;
}

export function fastModelNames(snapshot: FastModelSnapshot | undefined): string[] | undefined {
  return snapshot && Object.entries(snapshot.providers).flatMap(([provider, saved]) => saved.supportedModelIds.map(id => provider + "/" + id));
}

export function rejectsFastMode(snapshot: FastModelSnapshot | undefined, model: string): boolean {
  if (!snapshot?.ready) return false;
  const [provider, ...parts] = model.split("/");
  const saved = snapshot.providers[provider];

  return !saved || (!saved.error && !saved.supportedModelIds.includes(parts.join("/")));
}
