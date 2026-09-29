import { createMemo, createSignal, type Accessor } from "solid-js";
import { goUsageBadge, normalizeCodexUsage, normalizeOpencodeGoUsage, useUsageClock } from "./appSupport";
import type { NativeTransport } from "./lib/nativeTransport";
import { createDependencyEffect } from "./lib/solid";
import type { CodexUsage, OpencodeGoUsage } from "./types";

export function useAppUsage(transport: Accessor<NativeTransport>) {
  const [codexUsage, setCodexUsage] = createSignal<CodexUsage>();
  const [opencodeGoUsage, setOpencodeGoUsage] = createSignal<OpencodeGoUsage>();
  const [usageClock, setUsageClock] = createSignal(0);
  const opencodeGoBadge = createMemo(() => { usageClock(); return goUsageBadge(opencodeGoUsage()); });
  createDependencyEffect(() => {
    const capturedTransport = transport();
    let cancelled = false;
    const load = () => {
      void capturedTransport.loadCodexUsage().then(usage => {
        if (!cancelled) setCodexUsage(normalizeCodexUsage(usage));
      }).catch(() => undefined);
      void capturedTransport.loadOpencodeGoUsage().then(usage => {
        if (!cancelled) setOpencodeGoUsage(normalizeOpencodeGoUsage(usage));
      }).catch(() => undefined);
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
  return { codexUsage, opencodeGoBadge, usageClock };
}
