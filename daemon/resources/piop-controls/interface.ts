import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ForkMode = "fork" | "fork_after" | "clone";

export type ForkResult = { hostId: string; sessionId: string; sessionPath: string; cwd: string; text?: string };

export type AuxiliaryCopy = { kind: string; name: string };

export interface SessionControls {
  stop(ctx: ExtensionContext): Promise<void>;
  cancelPreparation(): void;
  fork(ctx: ExtensionContext, mode: ForkMode, entryId?: string): Promise<ForkResult>;
  copyAuxiliary(ctx: ExtensionContext, copy: AuxiliaryCopy): Promise<ForkResult & { parentSessionId: string }>;
  rewindMessage(ctx: ExtensionCommandContext, entryId: string, keep: number[]): Promise<{ cancelled: boolean; images?: Array<{ type: "image"; data: string; mimeType: string }> }>;
}

export interface SessionControlsRequest { session?: SessionControls }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:controls:session", handler: (request: SessionControlsRequest) => void): () => void;
    emit(channel: "piop:controls:session", request: SessionControlsRequest): void;
  }
}

export function sessionControls(pi: ExtensionAPI): SessionControls | undefined {
  const request: SessionControlsRequest = {};
  pi.events.emit("piop:controls:session", request);

  return request.session;
}
