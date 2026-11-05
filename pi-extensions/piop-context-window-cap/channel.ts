export type { ContextCapSessionRequest } from "./interface.ts";
import type { ContextCapSessionRequest } from "./interface.ts";

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:context-cap:session", handler: (request: ContextCapSessionRequest) => void): () => void;
    emit(channel: "piop:context-cap:session", request: ContextCapSessionRequest): void;
  }
}
