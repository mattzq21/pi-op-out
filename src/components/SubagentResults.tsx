import { Key } from "@solid-primitives/keyed";
import { createMemo, useContext } from "solid-js";
import { ConversationHostContext, SubagentNavigationContext } from "../lib/subagentNavigation";

interface Run { name: string; task: string; status: string; sessionId: string; sessionPath: string; hostId: string; output?: string; apiCost?: number; }

function validRun(value: unknown): value is Run {
  if (!value || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return ["name", "task", "status", "sessionId", "sessionPath", "hostId"].every((key) => typeof run[key] === "string");
}

export function subagentRuns(details: unknown): Run[] {
  if (!details || typeof details !== "object") return [];
  const runs = (details as { runs?: unknown }).runs;
  return Array.isArray(runs) ? runs.filter(validRun) : [];
}

export function SubagentResults(props: { runs: Run[] }) {
  const open = useContext(SubagentNavigationContext);
  const host = useContext(ConversationHostContext);
  const rows = createMemo(() => props.runs.map((run, index) => ({ run, key: `${run.hostId}:${run.sessionId || run.sessionPath || `pending-${index}`}` })));
  return <div aria-label="Subagent results"><Key each={rows()} by="key">{row => {
    const run = () => row().run;
    return <section class="tool-payload">
    <div class="tool-payload-label">{run().name} · {run().status}{typeof run().apiCost === "number" && Number.isFinite(run().apiCost) ? ` · $${run().apiCost!.toFixed(4)}` : ""}</div>
    <p>{run().task}</p>
    {open && run().sessionId && run().sessionPath && <button type="button" onClick={() => open({ ...run(), hostId: host?.() ?? run().hostId })}>Open conversation</button>}
    {run().sessionId && <p>Conversation: <code>{run().hostId}/{run().sessionId}</code></p>}
    {run().sessionPath && <details><summary>Saved transcript</summary><div class="tool-output"><pre>{run().sessionPath}</pre></div></details>}
    {typeof run().output === "string" && run().output && <div class="tool-output"><pre>{run().output}</pre></div>}
  </section>;
  }}</Key></div>;
}
