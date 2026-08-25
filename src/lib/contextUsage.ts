import type { ContextUsage, RpcEvent } from "../types";

export function contextUsageAfterCompaction(current: ContextUsage | undefined, event: RpcEvent) {
  if (!current) return undefined;
  const estimate = (event.result as { estimatedTokensAfter?: unknown } | null)?.estimatedTokensAfter;
  if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) return current;
  return { ...current, tokens: estimate, percent: current.contextWindow > 0 ? estimate / current.contextWindow * 100 : null };
}
