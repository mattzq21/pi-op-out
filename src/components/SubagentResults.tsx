import { required } from "../lib/required";
import { Key } from "@solid-primitives/keyed";
import { createContext, createMemo, createSignal, createUniqueId, useContext } from "solid-js";
import { ArrowUpRight, Check, ChevronRight, CircleAlert, GitBranch, LoaderCircle, Pause } from "lucide-solid";
import { z } from "zod";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";
import "./subagent-timeline.css";

interface Run { name: string; task: string; status: string; sessionId: string; sessionPath: string; hostId: string; toolCallId?: string; output?: string; apiCost?: number; }

export const SubagentUpdatesContext = createContext<() => Map<string, Run>>();
export const subagentRunKey = (run: Run) => run.toolCallId && run.sessionId ? `${run.hostId}:${run.toolCallId}:${run.sessionId}` : undefined;

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
  const updates = useContext(SubagentUpdatesContext);
  const runs = createMemo(() => props.runs.map(run => updates?.().get(subagentRunKey(run) ?? "") ?? run));
  const rows = createMemo(() => runs().map((run, index) => ({ run, key: `${run.hostId}:${run.sessionId || run.sessionPath || `pending-${index}`}` })));
  const finished = createMemo(() => runs().length > 0 && runs().every(run => ["completed", "failed", "cancelled"].includes(run.status)));
  const issues = createMemo(() => runs().filter(run => run.status === "failed" || run.status === "cancelled").length);
  const [expanded, setExpanded] = createSignal(false);
  const visible = () => !finished() || expanded();
  const id = createUniqueId();
  const label = () => {
    const count = runs().length;
    const active = runs().filter(run => !["completed", "failed", "cancelled"].includes(run.status)).length;

    return `${finished() || active === count ? count : `${active} of ${count}`} ${count === 1 ? "agent" : "agents"} ${finished() ? "finished" : "working"}${issues() ? ` · ${issues()} ${issues() === 1 ? "needs" : "need"} attention` : ""}`;
  };

  return <section class="subagent-timeline" aria-label="Delegated work">
    <div class="subagent-timeline-heading">
      {finished() ? issues() ? <CircleAlert size={14} class="subagent-issue" /> : <Check size={14} class="subagent-completed" /> : <GitBranch size={14} />}
      <span role="status">{label()}</span>
      {finished() && <button type="button" class="subagent-toggle" aria-expanded={visible()} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded() ? "Hide work" : "View work"}<ChevronRight size={12} classList={{ "subagent-chevron-open": expanded() }} /></button>}
    </div>
    <div id={id} hidden={!visible()} class="subagent-branches"><Key each={rows()} by="key">{row => {
    const run = createMemo(() => row().run);

    return <div class="subagent-branch">
      <details class="subagent-work">
        <summary>
          <span class={`subagent-state subagent-${run().status}`} title={run().status}>{run().status === "running" ? <LoaderCircle size={14} class="subagent-spinner" /> : run().status === "completed" ? <Check size={14} /> : run().status === "cancelled" ? <Pause size={14} /> : <CircleAlert size={14} />}</span>
          <span class="subagent-name">{run().name}</span><span class="subagent-status">{run().status}</span><ChevronRight size={12} class="subagent-detail-chevron" />
        </summary>
        <div class="subagent-work-content">
          <div class="tool-payload-label">Assignment</div><p>{run().task}</p>
          {run().output && <><div class="tool-payload-label">Response</div><pre>{run().output}</pre></>}
          {Number.isFinite(run().apiCost) && <p class="subagent-cost">Cost · ${required(run().apiCost).toFixed(4)}</p>}
        </div>
      </details>
      {open && run().sessionId && run().sessionPath && <button type="button" class="subagent-view" aria-label={`View ${run().name} agent chat`} onClick={() => open({ ...run(), hostId: host?.() ?? run().hostId })}>View<ArrowUpRight size={13} /></button>}
    </div>;
  }}</Key></div></section>;
}
