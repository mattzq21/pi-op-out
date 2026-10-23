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
    return { color: `hsl(${hue} 75% 62%)`, size: petals === 3 ? 4.6 : petals === 4 ? 4 : 3.2, angles: Array.from({ length: petals }, (_, index) => index * 360 / petals + ((hash >>> 16) % 45)) };
  });
  return <span class={`subagent-state subagent-${props.status}`} role="img" aria-label={props.label}>
    <svg class="subagent-avatar" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <Index each={look().angles}>{angle => <rect x={9 - look().size / 2} y={9 - 5 - look().size / 2} width={look().size} height={look().size} rx="1" transform={`rotate(${angle()} 9 9) rotate(45 9 4)`} fill={look().color} fill-opacity="0.18" stroke={look().color} stroke-width="1.2" />}</Index>
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
          <SubagentAvatar seed={run().sessionId || run().name} status={run().status} label={statusLabel()} />
          <span class="subagent-name">{run().name}</span>
      </button>
    </div>;
  }}</Key></section>;
}
