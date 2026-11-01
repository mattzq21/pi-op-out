import { createMemo, createSignal, type Accessor } from "solid-js";
import { Pencil, Trash2 } from "lucide-solid";
import { z } from "zod";

const goalSchema = z.object({ objective: z.string(), status: z.enum(["active", "complete"]) });

export type Goal = z.infer<typeof goalSchema>;

function readGoal(value?: string): { goal?: Goal; error?: string } {
  if (!value) return {};

  try {
    return { goal: goalSchema.parse(JSON.parse(value)) };
  } catch (reason) { return { error: `Could not show the goal: ${reason instanceof Error ? reason.message : String(reason)}` }; }
}

export function createGoalControls(source: Accessor<{ value?: string; disabled: boolean; onCommand: (action: string) => Promise<unknown> }>) {
  const read = createMemo(() => readGoal(source().value));
  const goal = createMemo(() => { const current = read().goal;

    return current?.status === "complete" ? undefined : current; });
  const [busy, setBusy] = createSignal(false);
  const [commandError, setCommandError] = createSignal<string>();

  const run = async (action: "clear" | "edit") => {
    if (source().disabled || busy()) return;
    setBusy(true); setCommandError(undefined);

    try { await source().onCommand(action); }
    catch (reason) { setCommandError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return { goal, error: () => read().error ?? commandError(), disabled: () => source().disabled || busy(), run };
}

export type GoalControls = ReturnType<typeof createGoalControls>;

export function GoalActions(props: { controls: GoalControls }) {
  return <>
    <button type="button" class="pending-icon-button" data-tooltip="Edit goal" aria-label="Edit goal" disabled={props.controls.disabled()} onClick={() => void props.controls.run("edit")}><Pencil size={12} /></button>
    <button type="button" class="pending-icon-button" data-tooltip="Clear goal" aria-label="Clear goal" disabled={props.controls.disabled()} onClick={() => void props.controls.run("clear")}><Trash2 size={13} /></button>
  </>;
}
