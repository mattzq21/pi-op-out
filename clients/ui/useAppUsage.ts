import { createMemo, createSignal } from "solid-js";
import { z } from "zod";
import { usageWindowsDescription, useUsageClock } from "./appSupport";
import { loadProviderUsage } from "./lib/nativeTransport";
import { listen } from "./lib/platform";
import { providerUsageSchema } from "./lib/responseSchemas";
import { createDependencyEffect } from "./lib/solid";

type UsageSnapshot = z.output<typeof providerUsageSchema>;

const sameValue = (previous: unknown, next: unknown) => JSON.stringify(previous) === JSON.stringify(next);

/** A provider shows only once it has usage; a provider that never answered, such as one without a login, stays hidden. */
const loaded = <T>(entry?: { usage?: T; error?: string }) => (entry?.usage === undefined ? undefined : { usage: entry.usage, error: entry.error });

/** Plan usage that the daemon reads for all clients. A start or reload asks for one fresh read; later values come as events. */
export function useAppUsage() {
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot>({});
  const [usageError, setUsageError] = createSignal<string>();
  const [usageClock, setUsageClock] = createSignal(0);

  createDependencyEffect(() => {
    let stopped = false;
    let revision = 0;
    const show = (value: UsageSnapshot) => { revision++; setSnapshot(value); setUsageError(undefined); };
    const load = (refresh: boolean) => {
      const loaded = revision;
      void loadProviderUsage(refresh).then(value => { if (!stopped && loaded === revision) show(value); })
        .catch(reason => { if (!stopped) setUsageError(`Usage unavailable: ${reason instanceof Error ? reason.message : String(reason)}`); });
    };
    const changes = listen("pi://usage-changed", ({ payload }) => { if (!stopped) show(payload); }, providerUsageSchema);
    // Events sent while the phone was offline are lost, so a restored connection loads the usage again.
    const restored = listen("pi://event", ({ payload }) => { if (payload.type === "connection_restored") load(false); }, z.object({ type: z.string().optional() }).catch({}));
    load(true);

    return () => { stopped = true; for (const stop of [changes, restored]) void stop.then(unlisten => unlisten()); };
  }, () => []);

  const codexUsage = createMemo(() => loaded(snapshot().codex), undefined, { equals: sameValue });
  const anthropicUsage = createMemo(() => loaded(snapshot().anthropic), undefined, { equals: sameValue });
  const opencodeGoUsage = createMemo(() => loaded(snapshot().opencodeGo), undefined, { equals: sameValue });
  const opencodeGoBadge = createMemo(() => { const entry = opencodeGoUsage();

    return entry && { window: entry.usage.rolling, detail: usageWindowsDescription(entry.usage), error: entry.error }; });

  useUsageClock(() => [codexUsage()?.usage.resetAt, anthropicUsage()?.usage.resetAt, opencodeGoUsage()?.usage.rolling.resetAt], () => (setUsageClock));

  return { codexUsage, anthropicUsage, opencodeGoBadge, usageClock, usageError };
}
