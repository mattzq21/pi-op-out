import type { ChatMessage } from "../types";

export interface SubagentFacts { look?: number; task?: string }

const runsOf = (message: ChatMessage): unknown => message.role === "tool" && (message.toolName === "spawn_subagents" || message.toolName === "await_subagents") ? message.subagents
  : message.customType === "piop-subagent-result" ? (message.details as { runs?: unknown } | undefined)?.runs : undefined;

export function subagentFacts(messages: readonly ChatMessage[], hostId: string): ReadonlyMap<string, SubagentFacts> {
  const facts = new Map<string, SubagentFacts>();

  for (const message of messages) {
    const runs = runsOf(message);

    if (!Array.isArray(runs)) continue;
    for (const run of runs as Array<{ sessionId?: unknown; look?: unknown; task?: unknown }>) {
      if (typeof run?.sessionId !== "string" || !run.sessionId) continue;
      const key = `${hostId}:${run.sessionId}`;
      const look = Number.isInteger(run.look) && (run.look as number) >= 0 && (run.look as number) < 48 ? run.look as number : facts.get(key)?.look;
      const task = typeof run.task === "string" ? run.task.slice(0, 200) : facts.get(key)?.task;
      facts.set(key, { look, task });
    }
  }

  return facts;
}

export const sameFacts = (left: ReadonlyMap<string, SubagentFacts>, right: ReadonlyMap<string, SubagentFacts>) => left.size === right.size && [...left].every(([key, facts]) => right.get(key)?.look === facts.look && right.get(key)?.task === facts.task);
