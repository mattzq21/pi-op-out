import { Key } from "@solid-primitives/keyed";
import { createMemo, useContext } from "solid-js";
import { CircleX, GitFork, GitMerge, Pause } from "lucide-solid";
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
          <span class={`subagent-state subagent-${run().status}`} data-tooltip={statusLabel()} role="img" aria-label={statusLabel()}>{run().status === "running" ? <GitFork size={14} /> : run().status === "completed" ? <GitMerge size={14} /> : run().status === "cancelled" ? <Pause size={14} /> : <CircleX size={14} />}</span>
          <span class="subagent-name">{run().name}</span>
      </button>
    </div>;
  }}</Key></section>;
}
