import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_DESKTOP_BROKER_URL;
const token = process.env.PI_DESKTOP_BROKER_TOKEN;

async function request(path: string, body?: unknown) {
  if (!url || !token) throw new Error("Pi Desktop session broker is unavailable");
  const response = await fetch(`${url}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json() as { error?: string; data?: unknown };
  if (!response.ok || result.error) throw new Error(result.error || `Session broker returned HTTP ${response.status}`);
  return result.data;
}

export default function sessionBroker(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => { pi.appendEntry("pi-desktop-llm-context", event.payload); });
  pi.registerTool({
    name: "list_agents", label: "List agents", description: "List Pi agents addressable through Pi Desktop", promptSnippet: "List agents by hostId and sessionId",
    parameters: Type.Object({}),
    async execute() { const data = await request("/agents"); return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data }; },
  });
  pi.registerTool({
    name: "send_message", label: "Send message", description: "Send a message to another Pi agent and wait for its reply", promptSnippet: "Message an agent by hostId and sessionId",
    parameters: Type.Object({ hostId: Type.String({ description: "Machine id, such as local" }), sessionId: Type.String({ description: "Pi session id" }), message: Type.String({ description: "Message for the target agent" }) }),
    async execute(_id, params) { const data = await request("/message", params); return { content: [{ type: "text", text: String((data as { reply?: unknown })?.reply ?? "") }], details: data }; },
  });
}
