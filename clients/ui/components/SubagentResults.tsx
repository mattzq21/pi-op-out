import { Key } from "@solid-primitives/keyed";
import { createMemo, Index, useContext } from "solid-js";
import { z } from "zod";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";
import "./subagent-timeline.css";

interface Run { name: string; task: string; status: string; sessionId: string; sessionPath: string; hostId: string; toolCallId?: string; output?: string; apiCost?: number; }

const runSchema = z.object({
  name: z.string(), task: z.string(), status: z.string(),
  sessionId: z.string(), sessionPath: z.string(), hostId: z.string(),
  toolCallId: z.string().optional(),
  output: z.string().optional().catch(undefined),
  apiCost: z.number().optional().catch(undefined),
});

export const subagentRuns = z.object({
  runs: z.array(runSchema.optional().catch(undefined)).catch([]),
}).transform(details => details.runs.flatMap(run => run ? [run] : [])).catch([]).parse;

/** Same string hash the ChatGPT app uses to pick a subagent avatar from its seed. */
function seedHash(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 2147483647;
  return hash;
}

const AVATAR_HUES = [18, 38, 52, 88, 140, 168, 192, 214, 246, 276, 308, 340];
const AVATAR_PETALS = [3, 4, 5, 6];

/** A fixed avatar per subagent session: the hue and petal count come from the session ID, so every row of one subagent looks the same. */
function SubagentAvatar(props: { seed: string; status: string; label: string }) {
  const look = createMemo(() => {
    const hash = seedHash(props.seed);
    const hue = AVATAR_HUES[hash % AVATAR_HUES.length]!;
    const petals = AVATAR_PETALS[Math.floor(hash / AVATAR_HUES.length) % AVATAR_PETALS.length]!;
    return { fill: `hsl(${hue} 70% 62%)`, stroke: `hsl(${hue} 60% 38%)`, angles: Array.from({ length: petals }, (_, index) => index * 360 / petals + (hash % 45)) };
  });
  return <span class={`subagent-state subagent-${props.status}`} data-tooltip={props.label} role="img" aria-label={props.label}>
    <svg class="subagent-avatar" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <Index each={look().angles}>{angle => <rect x="8" y="2.2" width="5" height="5" rx="1.2" transform={`rotate(${angle()} 8 8) rotate(45 8 2.2)`} fill={look().fill} fill-opacity="0.8" stroke={look().stroke} stroke-width="0.5" />}</Index>
      <circle class="subagent-status-dot" cx="13" cy="13" r="2.6" />
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
          <SubagentAvatar seed={run().sessionId || run().name} status={run().status} label={statusLabel()} />
          <span class="subagent-name">{run().name}</span>
      </button>
    </div>;
  }}</Key></section>;
}
