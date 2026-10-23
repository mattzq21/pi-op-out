import { batch, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import { goUsageBadge, normalizeCodexUsage, normalizeOpencodeGoUsage, useUsageClock } from "./appSupport";
import type { NativeTransport } from "./lib/nativeTransport";
import { createDependencyEffect } from "./lib/solid";
import type { CodexUsage, OpencodeGoUsage } from "./types";

export function useAppUsage(transport: Accessor<NativeTransport>) {
  const [codexUsage, setCodexUsage] = createSignal<CodexUsage>();
  const [opencodeGoUsage, setOpencodeGoUsage] = createSignal<OpencodeGoUsage>();
  const [usageClock, setUsageClock] = createSignal(0);
  const [codexUsageError, setCodexUsageError] = createSignal<string>();
  const [opencodeGoUsageError, setOpencodeGoUsageError] = createSignal<string>();

  const opencodeGoBadge = createMemo(() => { usageClock();

  return goUsageBadge(opencodeGoUsage()); });

  createDependencyEffect(() => {
    const capturedTransport = transport();
    let cancelled = false;
    let request = 0;

    const load = () => {
      const current = ++request;
      void capturedTransport.loadCodexUsage().then(usage => {
        if (!cancelled && current === request) batch(() => { setCodexUsage(normalizeCodexUsage(usage)); setCodexUsageError(undefined); });
      }).catch(reason => {
        if (!cancelled && current === request && (untrack(codexUsage) || untrack(codexUsageError))) batch(() => { setCodexUsage(undefined); setCodexUsageError(`Codex usage unavailable: ${reason instanceof Error ? reason.message : String(reason)}`); });
      });
      void capturedTransport.loadOpencodeGoUsage().then(usage => {
        if (!cancelled && current === request) batch(() => { setOpencodeGoUsage(normalizeOpencodeGoUsage(usage)); setOpencodeGoUsageError(undefined); });
      }).catch(reason => {
        if (!cancelled && current === request && (untrack(opencodeGoUsage) || untrack(opencodeGoUsageError))) batch(() => { setOpencodeGoUsage(undefined); setOpencodeGoUsageError(`OpenCode Go usage unavailable: ${reason instanceof Error ? reason.message : String(reason)}`); });
      });
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
  useUsageClock(() => (codexUsage()), () => (opencodeGoUsage()), () => (setUsageClock));

  return { codexUsage, opencodeGoBadge, usageClock, codexUsageError, opencodeGoUsageError };
}
