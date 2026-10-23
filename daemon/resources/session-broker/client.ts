import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerConversationClient(pi: ExtensionAPI) {
  pi.events.on("piop:rpc", request => {
    if (request.command !== "conversation_client") return;
    request.ready = Promise.resolve().then(() => {
      const client = request.payload?.clientId;
      if (typeof client !== "string" || !client) throw new Error("Conversation client is missing");
      process.env.PIOP_CONVERSATION_CLIENT = client;
      return null;
    });
  });
}

interface BrokerRequest {
  action?: string; sourceSessionId?: string; sourceHostId?: string; sourceName?: string; wake?: boolean;
  hostId?: string; sessionId?: string; id?: string; cwd?: string; name?: string;
  message?: string; deliveryId?: string; sessionPath?: string; stateKey?: string | null; waitMs?: number; discardOnFailure?: boolean; deliverAs?: "steer" | "followUp";
  recoveryDepth?: number; data?: Record<string, unknown>;
}

const responseSchema = Type.Object({ error: Type.Optional(Type.String()), data: Type.Optional(Type.Unknown()) });

const url = process.env.PI_DESKTOP_BROKER_URL;

const token = process.env.PI_DESKTOP_BROKER_TOKEN;

export class BrokerRequestError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

function requestOptions(body: BrokerRequest | undefined, signal: AbortSignal) {
  return { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify({ ...body, clientId: process.env.PIOP_CONVERSATION_CLIENT }) : undefined, signal };
}

async function brokerResponse(response: Response) {
  const result = Parse(responseSchema, await response.json());

  if (!response.ok || result.error) throw new BrokerRequestError(result.error || `Session broker returned HTTP ${response.status}`, [408, 429].includes(response.status) || response.status >= 500);

  return result.data;
}

function requestError(message: string, transient: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();

  if (transient) throw new BrokerRequestError(message, true);
}

export async function request(path: string, body?: BrokerRequest, signal?: AbortSignal, timeoutMs = 10_000) {
  signal?.throwIfAborted();
  assertBrokerAvailable();
  const controller = new AbortController();

  const timeout = setTimeout(() => controller.abort(new Error("Session broker request timed out")), timeoutMs);

  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${url}${path}`, requestOptions(body, controller.signal));

    return await brokerResponse(response);
  } catch (error) {
    requestError((error instanceof Error ? error.message : String(error)), controller.signal.aborted || error instanceof TypeError, signal);
    throw error;
  }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

function assertBrokerAvailable() {
  if (!url || !token) throw new Error("piop session broker is unavailable");
}

export const currentHost = () => process.env.PI_DESKTOP_HOST_ID || "local";
