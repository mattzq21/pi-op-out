import { sessionStorage } from "../piop-storage/interface.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalReport, GoalView, GoalStatus } from "./interface.ts";

export const GOAL_CONTEXT = "piop-goal-context";
export type Goal = GoalView;

export function validateObjective(value: string) {
  const objective = value.trim();
  if (!objective || [...objective].length > 4000) throw new Error("Goal objective must contain 1–4,000 characters. Reference a file for longer instructions.");
  return objective;
}

export class GoalState {
  goal: Goal | null = null;
  private saved = "null";
  constructor(private pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext) {
    const file = ctx.sessionManager.getSessionFile();
    this.goal = file ? sessionStorage(this.pi).readGoal(file, ctx.sessionManager.getSessionId()) : null;
    this.saved = JSON.stringify(this.goal);
    this.save(ctx);
  }

  known(ctx: ExtensionContext, goalId: string) {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Save this conversation before preparing a goal");
    return sessionStorage(this.pi).knownGoal(file, ctx.sessionManager.getSessionId(), goalId);
  }

  setStatus(ctx: ExtensionContext, status: GoalStatus) {
    this.goal = { ...this.require(), status };
    this.save(ctx);
  }

  clear(ctx: ExtensionContext) { this.goal = null; this.save(ctx); }

  require() {
    if (!this.goal) throw new Error("No goal is set for this conversation.");
    return this.goal;
  }

  response(): GoalReport { return { goal: this.goal && { ...this.goal } }; }

  save(ctx: ExtensionContext) {
    const next = JSON.stringify(this.goal);
    if (next !== this.saved) {
      try {
        if (!ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before setting a goal");
        sessionStorage(this.pi).writeGoal(ctx.sessionManager.getSessionFile()!, ctx.sessionManager.getSessionId(), this.goal);
      } catch (error) { this.goal = JSON.parse(this.saved); throw error; }
      this.saved = next;
      if (!this.goal) process.emit("piop:goal-cleared", ctx.sessionManager.getSessionId());
    }
    this.publish(ctx);
  }

  publish(ctx: ExtensionContext) {
    ctx.ui.setWidget("piop-goal", undefined);
    ctx.ui.setStatus("piop-goal", this.goal ? JSON.stringify(this.goal) : undefined);
  }
}
