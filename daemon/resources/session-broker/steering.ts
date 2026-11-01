import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SteerSource = "user" | "peer";

export interface Steering {
  waiting(): boolean;
  onSteer(listener: (source: SteerSource) => void): () => void;
  peerSteered(): void;
}

const instances = new WeakMap<ExtensionAPI, Steering>();

export function steering(pi: ExtensionAPI): Steering {
  const existing = instances.get(pi);

  if (existing) return existing;
  let offered = 0;
  const listeners = new Set<(source: SteerSource) => void>();
  const notify = (source: SteerSource) => { for (const listener of [...listeners]) listener(source); };

  pi.on("input", event => { if (event.source !== "extension" && event.streamingBehavior === "steer") notify("user"); });
  pi.events.on("piop:rpc", request => {
    if (request.command !== "queue_steer") return;
    const steer = (request.payload as { steer?: unknown } | null)?.steer;
    const next = typeof steer === "number" && Number.isInteger(steer) && steer > 0 ? steer : 0;
    const added = next > offered;
    offered = next;

    if (added) notify("user");
  });
  const instance: Steering = {
    waiting: () => offered > 0,
    onSteer: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    peerSteered: () => notify("peer"),
  };
  instances.set(pi, instance);

  return instance;
}
