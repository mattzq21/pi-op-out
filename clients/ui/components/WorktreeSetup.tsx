import { createSignal, Show } from "solid-js";
import { ChevronRight, LoaderCircle } from "lucide-solid";
import { z } from "zod";

export const WORKTREE_SETUP = "piop-worktree-setup";

const setupSchema = z.object({ state: z.enum(["running", "succeeded", "failed", "stopped"]), script: z.string().optional(), reason: z.string().optional(), output: z.string() });

export type WorktreeSetupView = z.infer<typeof setupSchema>;

export function readWorktreeSetup(value: unknown): WorktreeSetupView | undefined {
  const parsed = setupSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function title(setup: WorktreeSetupView) {
  if (setup.state === "running") return "Worktree setup running";
  if (setup.state === "succeeded") return "Worktree setup finished";

  return `Worktree setup ${setup.state} in ${setup.script} (${setup.reason})`;
}

// The output of the setup scripts of a chat worktree: live while they run, then from the transcript.
export function WorktreeSetup(props: { setup: WorktreeSetupView; onStop?: () => Promise<unknown> }) {
  const [stopping, setStopping] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    if (!props.onStop || stopping()) return;
    setStopping(true); setError(undefined);
    props.onStop().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setStopping(false));
  };

  return <details class="context-injection worktree-setup" classList={{ failed: props.setup.state === "failed" || props.setup.state === "stopped" }}>
    <summary>
      <Show when={props.setup.state === "running"}><LoaderCircle class="mcp-loading-spinner" size={12} aria-hidden="true" /></Show>
      {title(props.setup)}<ChevronRight size={12} aria-hidden="true" />
      <Show when={props.setup.state === "running" && props.onStop}><button type="button" class="worktree-setup-stop" disabled={stopping()} onClick={stop}>Stop</button></Show>
    </summary>
    <Show when={error()}>{message => <p role="alert">{message()}</p>}</Show>
    <div class="context-injection-content">{props.setup.output || "No output"}</div>
  </details>;
}
