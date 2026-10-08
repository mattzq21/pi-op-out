import { createMemo, createSignal, Show } from "solid-js";
import { CirclePause, CirclePlay, Pencil, Trash2 } from "lucide-solid";
import { z } from "zod";
import "./goal-bar.css";

const labels = { active: "Pursuing goal", paused: "Goal paused", blocked: "Goal blocked", usage_limited: "Usage limit reached", budget_limited: "Goal budget reached", complete: "Goal complete" };

const goalSchema = z.object({
  objective: z.string(), status: z.enum(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]),
  tokensUsed: z.number(), tokenBudget: z.number().nullable().optional(), elapsedMs: z.number(),
  legacyUsageUncertainTokens: z.number().optional(),
});

type Goal = z.infer<typeof goalSchema>;

function readGoal(value?: string): Goal | undefined {
  if (!value) return;

  try {
    return goalSchema.parse(JSON.parse(value));
  } catch { return; }
}

function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) return `${seconds}s`;

  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function GoalBar<T>(props: { value?: string; disabled: boolean; onCommand: (action: string) => Promise<T> }) {
  const goal = createMemo(() => {
    const current = readGoal(props.value);

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

  return <Show when={goal()}>{current => <section class="goal-bar" aria-label="Conversation goal">
    <div class="goal-bar-row">
      <span class="goal-bar-status" data-tooltip={labels[current().status]}>/goal</span>
      <span class="goal-bar-objective" data-tooltip={current().objective}>{current().objective}</span>
      <span class="goal-bar-time" data-tooltip="Active time">{duration(current().elapsedMs)}</span>
      <Show when={current().legacyUsageUncertainTokens}><span class="goal-bar-time" data-tooltip={`${current().legacyUsageUncertainTokens} older subagent tokens may already be included in the saved goal total.`}>Usage uncertain</span></Show>
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
  </section>}</Show>;
}
