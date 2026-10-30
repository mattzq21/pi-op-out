import { Key } from "@solid-primitives/keyed";
import { createMemo, Index, useContext } from "solid-js";
import { z } from "zod";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";
import { subagentLook } from "../lib/subagentLooks";
import "./subagent-timeline.css";

interface Run { name: string; task: string; status: string; sessionId: string; sessionPath: string; hostId: string; toolCallId?: string; look?: number; output?: string; apiCost?: number; }

const runSchema = z.object({
  name: z.string(), task: z.string(), status: z.string(),
  sessionId: z.string(), sessionPath: z.string(), hostId: z.string(),
  toolCallId: z.string().optional(),
  look: z.number().int().min(0).max(47).optional().catch(undefined),
  output: z.string().optional().catch(undefined),
  apiCost: z.number().optional().catch(undefined),
});

/** Tools whose rows show subagent icons: spawn_subagents shows the subagents it started, await_subagents the ones whose answers it returned. */
export const showsSubagents = (toolName?: string) => toolName === "spawn_subagents" || toolName === "await_subagents";

export const subagentRuns = z.object({
  runs: z.array(runSchema.optional().catch(undefined)).catch([]),
}).transform(details => details.runs.flatMap(run => run ? [run] : [])).catch([]).parse;

/** A fixed avatar per subagent: the daemon saves a look with each subagent before its chat exists, and the seed is its nickname, so every row of one subagent looks the same. */
function SubagentAvatar(props: { seed: string; look?: number; status: string; label: string }) {
  const look = createMemo(() => {
    const value = subagentLook(props.seed, props.look);
    const size = value.petals === 3 ? 4.6 : value.petals === 4 ? 4 : 3.2;
    return { color: value.color, size, radius: size * value.roundness, angles: Array.from({ length: value.petals }, (_, index) => index * 360 / value.petals + value.turn) };
  });
  return <span class={`subagent-state subagent-${props.status}`} role="img" aria-label={props.label}>
    <svg class="subagent-avatar" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <Index each={look().angles}>{angle => <rect x={9 - look().size / 2} y={9 - 5 - look().size / 2} width={look().size} height={look().size} rx={look().radius} transform={`rotate(${angle()} 9 9) rotate(45 9 4)`} fill={look().color} fill-opacity="0.18" stroke={look().color} stroke-width="1.2" />}</Index>
      <circle cx="9" cy="9" r="1.3" fill={look().color} />
      <circle class="subagent-status-dot" cx="16.5" cy="16.5" r="2.6" />
    </svg>
  </span>;
}

export function SubagentResults(props: { runs: Run[] }) {
  const open = useContext(SubagentNavigationContext);
  const host = useContext(ConversationHostContext);
  const rows = createMemo(() => props.runs.map((run, index) => ({ run, key: `${run.hostId}:${run.sessionId || run.sessionPath || `pending-${index}`}` })));

  return <section class="subagent-timeline" aria-label="Delegated work">
    <Key each={rows()} by="key">{row => {
    const run = createMemo(() => row().run);
    const statusLabel = () => run().status === "running" ? "Subagent started" : run().status === "completed" ? "Subagent succeeded" : run().status === "cancelled" ? "Subagent cancelled" : "Subagent failed";

    return <div class="subagent-branch">
      <button type="button" class="subagent-open" disabled={!open || !run().sessionId || !run().sessionPath} aria-label={`Open ${run().name} agent chat — ${statusLabel()}`} onClick={() => open?.({ ...run(), hostId: host?.() ?? run().hostId })}>
          <SubagentAvatar seed={run().name} look={run().look} status={run().status} label={statusLabel()} />
          <span class="subagent-name">{run().name}</span>
      </button>
    </div>;
  }}</Key></section>;
}
