import { batch, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import { goUsageBadge, normalizeCodexUsage, normalizeOpencodeGoUsage, useUsageClock } from "./appSupport";
import type { NativeTransport } from "./lib/nativeTransport";
import { createDependencyEffect } from "./lib/solid";
import type { CodexUsage, OpencodeGoUsage } from "./types";

/** A usage value and its error, loaded by one transport call. The error shows only once the usage has loaded or failed visibly before. */
function usageSource<T>(name: string, normalize: (value: unknown) => T | undefined) {
  const [usage, setUsage] = createSignal<T>();
  const [error, setError] = createSignal<string>();
  const load = (fetch: () => Promise<unknown>, isCurrent: () => boolean) => {
    void fetch().then(value => {
      if (isCurrent()) batch(() => { setUsage(() => normalize(value)); setError(undefined); });
    }).catch(reason => {
      if (isCurrent() && (untrack(usage) || untrack(error))) batch(() => { setUsage(undefined); setError(`${name} usage unavailable: ${reason instanceof Error ? reason.message : String(reason)}`); });
    });
  };

  return { usage, error, load };
}

export function useAppUsage(transport: Accessor<NativeTransport>) {
  const codex = usageSource<CodexUsage>("Codex", normalizeCodexUsage);
  const anthropic = usageSource<CodexUsage>("Anthropic", normalizeCodexUsage);
  const opencodeGo = usageSource<OpencodeGoUsage>("OpenCode Go", normalizeOpencodeGoUsage);
  const [usageClock, setUsageClock] = createSignal(0);

  const opencodeGoBadge = createMemo(() => { usageClock();

  return goUsageBadge(opencodeGo.usage()); });

  createDependencyEffect(() => {
    const capturedTransport = transport();
    let cancelled = false;
    let request = 0;

    const load = () => {
      const current = ++request;
      const isCurrent = () => !cancelled && current === request;
      codex.load(() => capturedTransport.loadCodexUsage(), isCurrent);
      anthropic.load(() => capturedTransport.loadAnthropicUsage(), isCurrent);
      opencodeGo.load(() => capturedTransport.loadOpencodeGoUsage(), isCurrent);
    };

    load();
    const interval = window.setInterval(load, 60_000);
    window.addEventListener("focus", load);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", load);
    };
  }, () => [transport()]);
  useUsageClock(() => [codex.usage()?.resetAt, anthropic.usage()?.resetAt, opencodeGo.usage()?.rolling.resetAt, opencodeGo.usage()?.weekly.resetAt, opencodeGo.usage()?.monthly.resetAt], () => (setUsageClock));

  return { codexUsage: codex.usage, anthropicUsage: anthropic.usage, opencodeGoBadge, usageClock, codexUsageError: codex.error, anthropicUsageError: anthropic.error, opencodeGoUsageError: opencodeGo.error };
}
