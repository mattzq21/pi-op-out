import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_DESKTOP_BROKER_URL;
const token = process.env.PI_DESKTOP_BROKER_TOKEN;

const MESSAGE_TIMEOUT_MS = 120_000;

async function cancelRequest(requestId: string) {
  if (!url || !token) return;
  await fetch(`${url}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }).catch(() => undefined);
}

async function request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000) {
  if (!url || !token) throw new Error("Pi Desktop session broker is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Session broker request timed out")), timeoutMs);
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${url}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const result = await response.json() as { error?: string; data?: unknown };
    if (!response.ok || result.error) throw new Error(result.error || `Session broker returned HTTP ${response.status}`);
    return result.data;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export default function sessionBroker(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_agents", label: "List agents", description: "List Pi agents addressable through Pi Desktop", promptSnippet: "List agents by hostId and sessionId",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) { const data = await request("/agents", undefined, signal); return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data }; },
  });
  pi.registerTool({
    name: "send_message", label: "Send message", description: "Send a message to another Pi agent and wait for its reply", promptSnippet: "Message an agent by hostId and sessionId",
    parameters: Type.Object({ hostId: Type.String({ description: "Machine id, such as local" }), sessionId: Type.String({ description: "Pi session id" }), message: Type.String({ description: "Message for the target agent" }) }),
    async execute(_id, params, signal) {
      const requestId = crypto.randomUUID();
      const abort = () => { void cancelRequest(requestId); }; signal?.addEventListener("abort", abort, { once: true });
      try {
        const data = await request("/message", { ...params, requestId }, signal, MESSAGE_TIMEOUT_MS);
        return { content: [{ type: "text", text: String((data as { reply?: unknown })?.reply ?? "") }], details: data };
      } finally { signal?.removeEventListener("abort", abort); }
    },
  });
}
