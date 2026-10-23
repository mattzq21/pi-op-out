import { createMemo, createSignal, Show } from "solid-js";
import { CirclePause, CirclePlay, Pencil, Trash2 } from "lucide-solid";
import { z } from "zod";
import "./goal-bar.css";


const goalSchema = z.object({
  objective: z.string(), status: z.enum(["active", "paused", "complete"]),
});

type Goal = z.infer<typeof goalSchema>;

function readGoal(value?: string): { goal?: Goal; error?: string } {
  if (!value) return {};

  try {
    return { goal: goalSchema.parse(JSON.parse(value)) };
  } catch (reason) { return { error: `Could not show the goal: ${reason instanceof Error ? reason.message : String(reason)}` }; }
}

export function GoalBar<T>(props: { value?: string; disabled: boolean; onCommand: (action: string) => Promise<T> }) {
  const read = createMemo(() => readGoal(props.value));
  const goal = createMemo(() => {
    const current = read().goal;

    return current?.status === "complete" ? undefined : current;
  });

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const run = async (action: string) => {
    if (props.disabled || busy()) return;
    setBusy(true); setError(undefined);

    try { await props.onCommand(action); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <><Show when={read().error}>{message => <section class="goal-bar" aria-label="Conversation goal"><div class="goal-bar-error" role="alert">{message()}</div></section>}</Show>
  <Show when={goal()}>{current => <section class="goal-bar" aria-label="Conversation goal">
    <div class="goal-bar-row">
      <span class="goal-bar-status">{current().status === "paused" && <span class="goal-bar-paused">PAUSED</span>}/goal</span>
      <span class="goal-bar-objective">{current().objective}</span>
      <button type="button" data-tooltip="Clear goal" aria-label="Clear goal" disabled={props.disabled || busy()} onClick={() => void run("clear")}><Trash2 size={14} /></button>
      <Show when={current().status !== "complete"}>
        <button type="button" data-tooltip={current().status === "active" ? "Pause goal" : "Resume goal"} aria-label={current().status === "active" ? "Pause goal" : "Resume goal"} disabled={props.disabled || busy()} onClick={() => void run(current().status === "active" ? "pause" : "resume")}>
          <Show when={current().status === "active"} fallback={<CirclePlay size={14} />}><CirclePause size={14} /></Show>
        </button>
      </Show>
      <button type="button" data-tooltip="Edit goal" aria-label="Edit goal" disabled={props.disabled || busy()} onClick={() => void run("edit")}>
        <Pencil size={13} />
      </button>
    </div>
    <Show when={error()}><div class="goal-bar-error" role="alert">{error()}</div></Show>
  </section>}</Show></>;
}
