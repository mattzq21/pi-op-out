import { randomUUID } from "node:crypto";

const url = process.env.PI_DESKTOP_BROKER_URL;

const token = process.env.PI_DESKTOP_BROKER_TOKEN;

export const MESSAGE_TIMEOUT_MS = 120_000;

export async function cancelRequest(requestId: string) {
  if (!url || !token) return;
  await fetch(`${url}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
}

function requestOptions(body: unknown, signal: AbortSignal) {
  return { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify({ ...(body as Record<string, unknown>), clientId: process.env.PIOP_CONVERSATION_CLIENT }) : undefined, signal };
}

async function brokerResponse(response: Response) {
  const result = await response.json() as { error?: string; data?: unknown };

  if (!response.ok || result.error) throw new Error(result.error || `Session broker returned HTTP ${response.status}`);

  return result.data;
}

export async function request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000) {
  signal?.throwIfAborted();
  assertBrokerAvailable();
  const controller = new AbortController();
  const operationId = path.startsWith("/worktrees/") ? randomUUID() : undefined;

  if (operationId) body = { ...(body as Record<string, unknown>), requestId: operationId, deadline: Date.now() + timeoutMs };
  const timeout = setTimeout(() => controller.abort(new Error("Session broker request timed out")), timeoutMs);
  const cancelOperation = () => { if (operationId) void cancelRequest(operationId); };

  controller.signal.addEventListener("abort", cancelOperation, { once: true });
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${url}${path}`, requestOptions(body, controller.signal));

    return await brokerResponse(response);
  } catch (error) { if (operationId) await cancelRequest(operationId); throw error; }
  finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", cancelOperation); signal?.removeEventListener("abort", abort); }
}

function assertBrokerAvailable() {
  if (!url || !token) throw new Error("piop session broker is unavailable");
}

export const currentHost = () => process.env.PI_DESKTOP_HOST_ID || "local";
