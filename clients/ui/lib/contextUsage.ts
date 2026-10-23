import type { ContextUsage, RpcEvent } from "../types";
import { z } from "zod";

const compactionResultSchema = z.object({ estimatedTokensAfter: z.number().nonnegative() });

export function contextUsageAfterCompaction(current: ContextUsage | undefined, event: RpcEvent) {
  if (!current) return undefined;
  const result = compactionResultSchema.safeParse(event.result);

  if (!result.success) return current;
  const estimate = result.data.estimatedTokensAfter;

  return { ...current, tokens: estimate, percent: current.contextWindow > 0 ? estimate / current.contextWindow * 100 : null };
}
