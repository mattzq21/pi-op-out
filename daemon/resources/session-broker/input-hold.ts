import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Current-state record. data.held is true while a new chat waits for the user's first message. */
export const INPUT_HOLD = "piop-input-hold";

/**
 * Core: a chat that must stay idle until the user acts, for example a new branch. Extensions that start work on their own
 * at session start check held() first. The hold ends when the user sends input or any agent run starts.
 */
export interface InputHold { held(ctx: ExtensionContext): boolean }

/** Extensions emit this request on "piop:session:input-hold" to get the core InputHold. */
export interface InputHoldRequest { hold?: InputHold }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:session:input-hold", handler: (request: InputHoldRequest) => void): () => void;
    emit(channel: "piop:session:input-hold", request: InputHoldRequest): void;
  }
}

/** The core InputHold. Throws when the core session broker is not loaded, so callers never start work by mistake. */
export function inputHold(pi: ExtensionAPI): InputHold {
  const request: InputHoldRequest = {};
  pi.events.emit("piop:session:input-hold", request);
  if (!request.hold) throw new Error("The Piop session core is not loaded, so it is unknown whether this chat may start work");

  return request.hold;
}

export function registerInputHold(pi: ExtensionAPI) {
  const held = (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager.getEntries().findLast(item => item.type === "custom" && item.customType === INPUT_HOLD);

    return entry?.type === "custom" && (entry.data as { held?: unknown } | undefined)?.held === true;
  };
  const release = (ctx: ExtensionContext) => { if (held(ctx)) pi.appendEntry(INPUT_HOLD, { held: false }); };
  const off = pi.events.on("piop:session:input-hold", request => { request.hold = { held }; });

  pi.on("input", (event, ctx) => { if (event.source !== "extension") release(ctx); });
  pi.on("agent_start", (_event, ctx) => release(ctx));
  pi.on("session_shutdown", () => off());
}
