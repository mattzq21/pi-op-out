import { Key } from "@solid-primitives/keyed";
import { createMemo, useContext } from "solid-js";
import { z } from "zod";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";
import { SubagentAvatar } from "./AgentIcon";
import "./subagent-timeline.css";

interface Run { name: string; status?: string; sessionId: string; sessionPath: string; hostId: string; toolCallId?: string; look?: number; }

const runSchema = z.object({
  name: z.string(), status: z.string().optional().catch(undefined),
  sessionId: z.string(), sessionPath: z.string(), hostId: z.string(),
  toolCallId: z.string().optional(),
  look: z.number().int().min(0).max(47).optional().catch(undefined),
});

const runList = z.array(runSchema.optional().catch(undefined)).catch([]).transform(runs => runs.flatMap(run => run ? [run] : []));

export { showsSubagents } from "../lib/subagentTools";

export const subagentRuns = z.object({ runs: runList }).transform(details => details.runs).catch([]).parse;

export const toolSubagentRuns = runList.catch([]).parse;

function StatusAvatar(props: { seed: string; look?: number; status?: string }) {
  return <span class={props.status ? `subagent-state subagent-${props.status}` : "subagent-state"}><SubagentAvatar seed={props.seed} look={props.look} /></span>;
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
          <StatusAvatar seed={run().name} look={run().look} status={run().status} />
          <span class="subagent-name">{run().name}</span>
      </button>
    </div>;
  }}</Key></section>;
}
