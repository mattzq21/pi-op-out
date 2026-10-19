import { sessionStorage } from "../piop-storage/interface.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { current, validate } from "./goal-records.cjs";
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
    this.goal = current(ctx.sessionManager.getBranch());
    this.saved = JSON.stringify(this.goal);
    if (this.goal && this.goal.sessionId !== ctx.sessionManager.getSessionId()) {
      this.goal = { ...this.goal, id: randomUUID(), sessionId: ctx.sessionManager.getSessionId() };
    }
    this.save(ctx);
  }

  create(ctx: ExtensionContext, objective: string) {
    if (this.goal && this.goal.status !== "complete") throw new Error("This conversation has an unfinished goal. Use /goal edit or /goal clear first.");
    this.goal = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), objective: validateObjective(objective), status: "active" };
    this.save(ctx);
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
        validate(this.goal);
        sessionStorage(this.pi).append("piop-goal", this.goal && { ...this.goal });
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
