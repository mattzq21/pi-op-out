import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PauseState = { isPaused: boolean; isPausing: boolean };

/**
 * fork: copy the history before the user message entryId and return its text.
 * fork_after: copy the history up to the assistant response entryId and its tool results.
 * clone: copy the history up to the current leaf; entryId is ignored.
 */
export type ForkMode = "fork" | "fork_after" | "clone";

export type ForkResult = { hostId: string; sessionId: string; sessionPath: string; cwd: string; text?: string };

/** One instance per Pi session. Operations act on the conversation of the given context. */
export interface SessionControls {
  pauseState(): PauseState;
  /** Stops the current run and keeps the session paused until resume. An active goal pauses. Resolves when Pi is idle. */
  pause(ctx: ExtensionContext): Promise<void>;
  /**
   * Continues a stopped goal, then returns the message that resumes the paused run; undefined when the session is not paused.
   * Rejects while pausing or busy, or when the goal cannot continue.
   */
  resume(ctx: ExtensionContext): Promise<string | undefined>;
  /** Stops the current run and clears any pause. An active goal pauses. Resolves when Pi is idle. */
  stop(ctx: ExtensionContext): Promise<void>;
  /** Cancels child sessions that are still being prepared. */
  cancelPreparation(): void;
  /** Saves a copy of this conversation as a new conversation. Does not switch to it. */
  fork(ctx: ExtensionContext, mode: ForkMode, entryId?: string): Promise<ForkResult>;
  /** Moves this conversation back to the assistant response entryId and records that the later branch was dropped. */
  forkAndForget(ctx: ExtensionCommandContext, entryId: string): Promise<{ cancelled: boolean }>;
}

/** Other extensions emit this request on "piop:controls:session" to get the session interface. */
export interface SessionControlsRequest { session?: SessionControls }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:controls:session", handler: (request: SessionControlsRequest) => void): () => void;
    emit(channel: "piop:controls:session", request: SessionControlsRequest): void;
  }
}

/** The controls extension's session interface, or undefined when the extension is not loaded. */
export function sessionControls(pi: ExtensionAPI): SessionControls | undefined {
  const request: SessionControlsRequest = {};
  pi.events.emit("piop:controls:session", request);

  return request.session;
}
