import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerConversationClient(pi: ExtensionAPI) {
  pi.events.on("piop:rpc", request => {
    if (request.command !== "conversation_client") return;
    request.ready = Promise.resolve().then(() => {
      const client = (request.payload as { clientId?: unknown } | undefined)?.clientId;
      if (typeof client !== "string" || !client) throw new Error("Conversation client is missing");
      process.env.PIOP_CONVERSATION_CLIENT = client;
      return null;
    });
  });
}

interface BrokerRequest {
  action?: string; sourceName?: string; wake?: boolean;
  hostId?: string; sessionId?: string; id?: string; cwd?: string; name?: string;
  message?: string; deliveryId?: string; sessionPath?: string; stateKey?: string | null; waitMs?: number; discardOnFailure?: boolean; deliverAs?: "steer" | "followUp";
  recoveryDepth?: number; data?: Record<string, unknown>;
}

const answerSchema = Type.Union([Type.Object({ data: Type.Unknown() }), Type.Object({ error: Type.String(), transient: Type.Boolean() })]);

type RuntimeEventSender = (name: string, data: unknown) => Promise<unknown>;

export class BrokerRequestError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

function bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); settle(); };
    const timer = setTimeout(() => finish(() => reject(new BrokerRequestError("Session broker request timed out", true))), timeoutMs);
    const abort = () => finish(() => reject(signal?.reason));
    signal?.addEventListener("abort", abort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(new BrokerRequestError(error instanceof Error ? error.message : String(error), true))));
  });
}

export async function request(path: string, body?: BrokerRequest, signal?: AbortSignal, timeoutMs = 10_000) {
  signal?.throwIfAborted();
  const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as RuntimeEventSender | undefined;

  if (!send) throw new Error("piop session broker is unavailable");
  const answer = Parse(answerSchema, await bounded(send("broker", { path, body: { ...body, clientId: process.env.PIOP_CONVERSATION_CLIENT } }), signal, timeoutMs));

  if ("error" in answer) throw new BrokerRequestError(answer.error, answer.transient);

  return answer.data;
}

export const currentHost = () => process.env.PI_DESKTOP_HOST_ID || "local";
