import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type GoalStatus = "active" | "paused" | "complete";
export type GoalView = { id: string; sessionId: string; objective: string; status: GoalStatus };
export type GoalReport = { goal: GoalView | null };

export interface GoalSession {
  pause(ctx: ExtensionContext): Promise<GoalReport>;
  resume(ctx: ExtensionContext): Promise<GoalReport>;
  clear(ctx: ExtensionContext): Promise<GoalReport>;
  pauseWithSession(ctx: ExtensionContext): Promise<void>;
  resumeWithSession(ctx: ExtensionContext): Promise<void>;
}

/** Other extensions emit this request on "piop:goals:session" to get the session interface. */
export interface GoalSessionRequest { session?: GoalSession }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:goals:session", handler: (request: GoalSessionRequest) => void): () => void;
    emit(channel: "piop:goals:session", request: GoalSessionRequest): void;
  }
}

/** The goals extension's session interface, or undefined when the extension is not loaded. */
export function goalSession(pi: ExtensionAPI): GoalSession | undefined {
  const request: GoalSessionRequest = {};
  pi.events.emit("piop:goals:session", request);

  return request.session;
}
