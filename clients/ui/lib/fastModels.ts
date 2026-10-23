import { reportBackgroundError } from "./backgroundErrors";
import { createSignal, type Accessor, type Setter } from "solid-js";
import { z } from "zod";
import { invoke, listen } from "./platform";

/** The host's fast model results. ready is false until the host finishes its first full scan. */
const snapshotSchema = z.object({
  ready: z.boolean(),
  providers: z.record(z.string(), z.object({ supportedModelIds: z.array(z.string()), error: z.string().optional() })),
  error: z.string().optional(),
});

export type FastModelSnapshot = z.infer<typeof snapshotSchema>;

const hosts = new Map<string, { snapshot: Accessor<FastModelSnapshot | undefined>; set: Setter<FastModelSnapshot | undefined> }>();

let watching = false;

function load(hostId: string) {
  const entry = hosts.get(hostId);

  if (!entry) return;
  void invoke("provider_auth", { hostId, request: { action: "fast_models" } }, snapshotSchema)
    .then(snapshot => entry.set(snapshot))
    .catch(reason => reportBackgroundError("Could not load fast models for host " + hostId, reason));
}

/** The host's fast model results, kept current by the host's change events. undefined until the first load. */
export function hostFastModels(hostId: string): Accessor<FastModelSnapshot | undefined> {
  if (!watching) {
    watching = true;
    void listen("pi://fast-models-changed", ({ payload }) => load(payload.hostId), z.object({ hostId: z.string() }));
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

/** The "provider/model" names that the host found to support fast mode. */
export function fastModelNames(snapshot: FastModelSnapshot | undefined): string[] | undefined {
  return snapshot && Object.entries(snapshot.providers).flatMap(([provider, saved]) => saved.supportedModelIds.map(id => provider + "/" + id));
}

/** True when the host's results show that a model does not support fast mode. Unknown results are not a rejection. */
export function rejectsFastMode(snapshot: FastModelSnapshot | undefined, model: string): boolean {
  if (!snapshot?.ready) return false;
  const [provider, ...parts] = model.split("/");
  const saved = snapshot.providers[provider];

  return !saved || (!saved.error && !saved.supportedModelIds.includes(parts.join("/")));
}
