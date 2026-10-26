import { z } from "zod";
import { createSignal, onCleanup } from "solid-js";
import { createDependencyEffect } from "./solid";
import { invoke, listen } from "./platform";

/** The number of the connected daemon's sessions that have saved settings they did not apply yet. It loads again each time the daemon connects. */
export function createSettingsPendingCount(connected: () => boolean, onError: (message: string) => void) {
  const [count, setCount] = createSignal(0);
  let revision = 0;

  const load = () => {
    const current = ++revision;
    void invoke("settings_pending_count", undefined, z.number().int().nonnegative())
      .then(value => { if (current === revision) setCount(value); })
      .catch(reason => onError(reason instanceof Error ? reason.message : String(reason)));
  };

  createDependencyEffect(() => { if (connected()) load(); }, () => [connected()]);
  const listeners = [
    listen("pi://settings-pending", ({ payload }) => { if (payload.hostId !== "local") return; revision++; setCount(payload.count); }, z.object({ hostId: z.string(), count: z.number().int().nonnegative() })),
    listen("pi://event", ({ payload }) => { if (payload.type === "connection_restored") load(); }, z.object({ type: z.string().optional() }).loose()),
  ];
  onCleanup(() => { revision++; for (const listener of listeners) void listener.then(stop => stop()); });

  return count;
}
