import { Key } from "@solid-primitives/keyed";
import { createMemo, Index, useContext } from "solid-js";
import { z } from "zod";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";
import { subagentLook } from "../lib/subagentLooks";
import "./subagent-timeline.css";

interface Run { name: string; status?: string; sessionId: string; sessionPath: string; hostId: string; toolCallId?: string; look?: number; }

const runSchema = z.object({
  name: z.string(), status: z.string().optional().catch(undefined),
  sessionId: z.string(), sessionPath: z.string(), hostId: z.string(),
  toolCallId: z.string().optional(),
  look: z.number().int().min(0).max(47).optional().catch(undefined),
});

const runList = z.array(runSchema.optional().catch(undefined)).catch([]).transform(runs => runs.flatMap(run => run ? [run] : []));

export const showsSubagents = (toolName?: string) => toolName === "spawn_subagents" || toolName === "await_subagents";

export const subagentRuns = z.object({ runs: runList }).transform(details => details.runs).catch([]).parse;

export const toolSubagentRuns = runList.catch([]).parse;

function SubagentAvatar(props: { seed: string; look?: number; status?: string }) {
  const look = createMemo(() => {
    const value = subagentLook(props.seed, props.look);
    const size = value.petals === 3 ? 4.6 : value.petals === 4 ? 4 : 3.2;
    return { color: value.color, size, radius: size * value.roundness, angles: Array.from({ length: value.petals }, (_, index) => index * 360 / value.petals + value.turn) };
  });
  return <span class={props.status ? `subagent-state subagent-${props.status}` : "subagent-state"}>
    <svg class="subagent-avatar" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <Index each={look().angles}>{angle => <rect x={9 - look().size / 2} y={9 - 5 - look().size / 2} width={look().size} height={look().size} rx={look().radius} transform={`rotate(${angle()} 9 9) rotate(45 9 4)`} fill={look().color} fill-opacity="0.18" stroke={look().color} stroke-width="1.2" />}</Index>
      <circle cx="9" cy="9" r="1.3" fill={look().color} />
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
    return <div class="subagent-branch">
      <button type="button" class="subagent-open" disabled={!open || !run().sessionId || !run().sessionPath} aria-label={`Open ${run().name} agent chat`} onClick={() => open?.({ ...run(), hostId: host?.() ?? run().hostId })}>
          <SubagentAvatar seed={run().name} look={run().look} status={run().status} />
          <span class="subagent-name">{run().name}</span>
      </button>
    </div>;
  }}</Key></section>;
}
