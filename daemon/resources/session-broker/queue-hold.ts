import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Core: the user's hold on the conversation queue. The daemon owns the hold and saves it.
 * While held, extensions must not send queued work on their own, such as goal turns. When the hold ends, they may start again.
 */
export interface QueueHold {
  held(): boolean;
  /** Calls handler each time the hold ends. Returns the function that removes the handler. */
  onRelease(handler: (ctx: ExtensionContext) => void): () => void;
}

/** Extensions emit this request on "piop:session:queue-hold" to get the core QueueHold. */
export interface QueueHoldRequest { hold?: QueueHold }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:session:queue-hold", handler: (request: QueueHoldRequest) => void): () => void;
    emit(channel: "piop:session:queue-hold", request: QueueHoldRequest): void;
  }
}

/** The core QueueHold. Throws when the core session broker is not loaded, so callers never send work by mistake. */
export function queueHold(pi: ExtensionAPI): QueueHold {
  const request: QueueHoldRequest = {};
  pi.events.emit("piop:session:queue-hold", request);
  if (!request.hold) throw new Error("The Piop session core is not loaded, so it is unknown whether the queue is on hold");

  return request.hold;
}

/** The daemon gives the hold in PIOP_QUEUE_HELD when Pi starts, and sends queue_hold requests when it changes. */
export function registerQueueHold(pi: ExtensionAPI) {
  let held = process.env.PIOP_QUEUE_HELD === "1";
  const handlers = new Set<(ctx: ExtensionContext) => void>();
  const hold: QueueHold = {
    held: () => held,
    onRelease: handler => { handlers.add(handler); return () => { handlers.delete(handler); }; },
  };
  const offRequest = pi.events.on("piop:session:queue-hold", request => { request.hold = hold; });
  const offRpc = pi.events.on("piop:rpc", request => {
    if (request.command !== "queue_hold") return;
    request.ready = Promise.resolve().then(() => {
      const next = (request.payload as { held?: unknown } | undefined)?.held;
      if (typeof next !== "boolean") throw new Error("queue_hold needs held set to true or false");
      const released = held && !next;
      held = next;
      process.env.PIOP_QUEUE_HELD = next ? "1" : "0";
      if (released) for (const handler of handlers) handler(request.ctx);
      return null;
    });
  });

  pi.on("session_shutdown", () => { offRequest(); offRpc(); });
}
