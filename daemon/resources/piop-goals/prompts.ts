import type { Goal } from "./state.ts";

const objectiveUpdated = "The goal was edited by the user. Current goal is:\n{{ objective }}\nAvoid continuing work that only served the previous objective unless it also helps the updated objective.";

function render(template: string, goal: Goal) {
  const values = new Map([
    ["objective", goal.objective.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
  ]);

  return template.replace(/{{ (\w+) }}/g, (match, name: string) => values.get(name) ?? match);
}

/** The message that continues goal work: the objective as the user wrote it. */
export const goalPrompt = (goal: Goal) => goal.objective;

export const goalSetPrompt = "Work toward the current goal. Completion criteria are expected to be met.";

/** The notice for a running agent after the user changed the goal, or null when the change needs none: a paused or complete goal gets no notice. */
export function goalChangedPrompt(goal: Goal | null) {
  if (!goal) return "The goal has been cleared. Follow next instructions, the goal is in the past now.";

  return goal.status === "active" ? render(objectiveUpdated, goal) : null;
}
