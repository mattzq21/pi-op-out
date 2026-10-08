import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Parse } from "typebox/value";

interface BrokerRequest {
  action?: string; sourceSessionId?: string; sourceHostId?: string; wake?: boolean;
  hostId?: string; sessionId?: string; id?: string; cwd?: string; name?: string; deleteBranch?: boolean;
  message?: string; requestId?: string; deadline?: number; deliveryId?: string;
  recoveryDepth?: number;
  terminalId?: string; generation?: string; offset?: number; maxBytes?: number;
}

const responseSchema = Type.Object({ error: Type.Optional(Type.String()), data: Type.Optional(Type.Unknown()) });

const url = process.env.PI_DESKTOP_BROKER_URL;

const token = process.env.PI_DESKTOP_BROKER_TOKEN;

export const MESSAGE_TIMEOUT_MS = 120_000;

export class BrokerRequestError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

export async function cancelRequest(requestId: string) {
  if (!url || !token) return;
  await fetch(`${url}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
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
  const operationId = path.startsWith("/worktrees/") ? randomUUID() : undefined;

  if (operationId) body = { ...body, requestId: operationId, deadline: Date.now() + timeoutMs };
  const timeout = setTimeout(() => controller.abort(new Error("Session broker request timed out")), timeoutMs);
  const cancelOperation = () => { if (operationId) void cancelRequest(operationId); };

  controller.signal.addEventListener("abort", cancelOperation, { once: true });
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${url}${path}`, requestOptions(body, controller.signal));

    return await brokerResponse(response);
  } catch (error) {
    if (operationId) await cancelRequest(operationId);
    requestError(String(error), controller.signal.aborted || error instanceof TypeError, signal);
    throw error;
  }
  finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", cancelOperation); signal?.removeEventListener("abort", abort); }
}

function assertBrokerAvailable() {
  if (!url || !token) throw new Error("piop session broker is unavailable");
}

export const currentHost = () => process.env.PI_DESKTOP_HOST_ID || "local";
