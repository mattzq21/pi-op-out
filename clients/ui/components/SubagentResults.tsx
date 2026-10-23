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

/** The ChatGPT app's string hash, then a mix step so that similar seeds such as "Svg4" and "Svg5" land far apart. */
function seedHash(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 2147483647;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Hues far enough apart to tell apart at 14px. */
const AVATAR_HUES = [0, 40, 95, 160, 200, 235, 280, 320];
const AVATAR_PETALS = [3, 4, 6];

/** A fixed avatar per subagent session: the hue and petal count come from the session ID, so every row of one subagent looks the same. */
function SubagentAvatar(props: { seed: string; status: string; label: string }) {
  const look = createMemo(() => {
    const hash = seedHash(props.seed);
    const hue = AVATAR_HUES[hash % AVATAR_HUES.length]!;
    const petals = AVATAR_PETALS[(hash >>> 8) % AVATAR_PETALS.length]!;
    return { fill: `hsl(${hue} 75% 60%)`, stroke: `hsl(${hue} 65% 35%)`, angles: Array.from({ length: petals }, (_, index) => index * 360 / petals + ((hash >>> 16) % 45)) };
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
