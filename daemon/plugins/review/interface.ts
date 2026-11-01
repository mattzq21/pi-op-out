import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReviewImage = { type: "image"; data: string; mimeType: string; name?: string };

export type ReviewRequest = {
  scope?: string;
  images?: ReviewImage[];
};

export interface ReviewSession {
  start(ctx: ExtensionContext, request: ReviewRequest): Promise<void>;
}

export interface ReviewSessionRequest { session?: ReviewSession }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:reviews:session", handler: (request: ReviewSessionRequest) => void): () => void;
    emit(channel: "piop:reviews:session", request: ReviewSessionRequest): void;
  }
}

export function reviewSession(pi: ExtensionAPI): ReviewSession | undefined {
  const request: ReviewSessionRequest = {};
  pi.events.emit("piop:reviews:session", request);

  return request.session;
}
