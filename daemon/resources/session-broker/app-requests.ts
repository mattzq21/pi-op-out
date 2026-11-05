import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// A request from the app. The session broker sends each one on the "piop:rpc" channel; the extension that knows the
// command sets ready.
export interface AppRequest { command: string; payload: unknown; ctx: ExtensionCommandContext; ready?: Promise<unknown> }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:rpc", handler: (request: AppRequest) => void): () => void;
    emit(channel: "piop:rpc", request: AppRequest): void;
  }
}

// The name of the slash command that a run_command request runs, or undefined for other requests.
export function slashCommand(request: AppRequest): string | undefined {
  if (request.command !== "run_command" || typeof request.payload !== "object" || request.payload === null) return undefined;
  const command = (request.payload as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}
