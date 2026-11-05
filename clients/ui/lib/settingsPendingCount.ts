import { z } from "zod";
import { createSignal, onCleanup } from "solid-js";
import { createDependencyEffect } from "./solid";
import { invoke, listen } from "./platform";
import { backgroundAttempt } from "./backgroundErrors";

export function createSettingsPendingCount(connected: () => boolean) {
  const [count, setCount] = createSignal(0);
  let revision = 0;

  const load = () => {
    const current = ++revision;
    const attempt = backgroundAttempt("settings-pending-count", "Could not read which sessions still apply saved settings");
    void invoke("settings_pending_count")
      .then(value => { attempt.succeeded(); if (current === revision) setCount(value); }, attempt.failed);
  };

  createDependencyEffect(() => { if (connected()) load(); }, () => [connected()]);
  const listeners = [
    listen("pi://settings-pending", ({ payload }) => { if (payload.hostId !== "local") return; revision++; setCount(payload.count); }, z.object({ hostId: z.string(), count: z.number().int().nonnegative() })),
    listen("pi://event", ({ payload }) => { if (payload.type === "connection_restored") load(); }, z.object({ type: z.string().optional() }).loose()),
  ];
  onCleanup(() => { revision++; for (const listener of listeners) void listener.then(stop => stop()); });

  return count;
}
