import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface QueueHold {
  held(): boolean;
  onRelease(handler: (ctx: ExtensionContext) => void): () => void;
}

export interface QueueHoldRequest { hold?: QueueHold }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:session:queue-hold", handler: (request: QueueHoldRequest) => void): () => void;
    emit(channel: "piop:session:queue-hold", request: QueueHoldRequest): void;
  }
}

export function queueHold(pi: ExtensionAPI): QueueHold {
  const request: QueueHoldRequest = {};
  pi.events.emit("piop:session:queue-hold", request);
  if (!request.hold) throw new Error("The Piop session core is not loaded, so it is unknown whether the queue is on hold");

  return request.hold;
}

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
