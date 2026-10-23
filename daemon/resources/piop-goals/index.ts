import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoals } from "./goals.ts";
import { registerGoalTools } from "./tools.ts";
import { registerGoalCommands } from "./commands.ts";

/** Conversation goals: goal state, goal tools, the /goal command and Piop goal input. Publishes GoalSession on "piop:goals:session". */
export default function goals(pi: ExtensionAPI) {
  const { session, core } = registerGoals(pi);
  registerGoalTools(pi, core);
  registerGoalCommands(pi, session, core);
}
