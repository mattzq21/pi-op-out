import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReviewImage = { type: "image"; data: string; mimeType: string; name?: string };

/** none: the reviewer works alone. auto: the reviewer picks a proportionate number of review subagents. A number: exactly that many subagents. */
export type ReviewDelegation = "none" | "auto" | number;

export type ReviewRequest = {
  /** Review scope added to the review prompt. */
  scope?: string;
  delegation: ReviewDelegation;
  /** Images sent with the review task. */
  images?: ReviewImage[];
};

/** One instance per Pi session. Operations act on the conversation of the given context. */
export interface ReviewSession {
  /**
   * Creates a review conversation with the configured review agent and prompt, links it to this saved conversation
   * and opens it in the side pane. Rejects when the conversation is not saved, settings are invalid or the review agent is unavailable.
   */
  start(ctx: ExtensionContext, request: ReviewRequest): Promise<void>;
  /** Opens a review linked to this conversation. A review inherited from a parent conversation opens read-only. */
  open(ctx: ExtensionContext, reviewId: string): Promise<void>;
  /** Sends feedback from a review of this conversation as a follow-up that starts a turn. */
  sendFeedback(ctx: ExtensionContext, reviewId: string, message: string): Promise<void>;
}

/** Other extensions emit this request on "piop:reviews:session" to get the session interface. */
export interface ReviewSessionRequest { session?: ReviewSession }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:reviews:session", handler: (request: ReviewSessionRequest) => void): () => void;
    emit(channel: "piop:reviews:session", request: ReviewSessionRequest): void;
  }
}

/** The reviews extension's session interface, or undefined when the extension is not loaded. */
export function reviewSession(pi: ExtensionAPI): ReviewSession | undefined {
  const request: ReviewSessionRequest = {};
  pi.events.emit("piop:reviews:session", request);

  return request.session;
}
