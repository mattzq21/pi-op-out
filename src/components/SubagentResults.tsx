import { required } from "../lib/required";
import { Key } from "@solid-primitives/keyed";
import { createMemo, useContext } from "solid-js";
import { z } from "zod";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";

interface Run { name: string; task: string; status: string; sessionId: string; sessionPath: string; hostId: string; output?: string; apiCost?: number; }

const runSchema = z.object({
  name: z.string(), task: z.string(), status: z.string(),
  sessionId: z.string(), sessionPath: z.string(), hostId: z.string(),
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

  return <div aria-label="Subagent results"><Key each={rows()} by="key">{row => {
    const run = createMemo(() => row().run);

    return <section class="tool-payload">
    <div class="tool-payload-label">{run().name} · {run().status}{Number.isFinite(run().apiCost) ? ` · $${required(run().apiCost).toFixed(4)}` : ""}</div>
    <p>{run().task}</p>
    {open && run().sessionId && run().sessionPath && <button type="button" onClick={() => open({ ...run(), hostId: host?.() ?? run().hostId })}>Open conversation</button>}
    {run().sessionId && <p>Conversation: <code>{run().hostId}/{run().sessionId}</code></p>}
    {run().sessionPath && <details><summary>Saved transcript</summary><div class="tool-output"><pre>{run().sessionPath}</pre></div></details>}
    {run().output && <div class="tool-output"><pre>{run().output}</pre></div>}
  </section>;
  }}</Key></div>;
}
