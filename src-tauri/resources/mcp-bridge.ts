import { createHash } from "node:crypto";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";

type Selection = { servers: Record<string, McpServerConfig>; agentName: string; sessionId: string; registered?: Promise<string[]> };

type ToolRequest = { tools?: string[]; availableTools?: string[] };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:mcp:select", handler: (selection: Selection) => void): () => void;
    emit(channel: "piop:mcp:select", selection: Selection): void;
    on(channel: "piop:mcp:tools", handler: (request: ToolRequest) => void): () => void;
    emit(channel: "piop:mcp:tools", request: ToolRequest): void;
  }
}

export default function agentMcp(pi: ExtensionAPI) {
  const registrations = new Map<string, string>();

  const nativeTools = () => pi.getAllTools().filter(tool =>
    tool.exposure !== "hidden" && ["builtin:mcp", "builtin:codemode", "builtin:tool-search"].includes(tool.sourceInfo?.path ?? ""));

  const activeTools = () => {
    const active = new Set(pi.getActiveTools());

    return nativeTools().filter(tool => active.has(tool.name)).map(tool => tool.name);
  };

  const stopTools = pi.events.on("piop:mcp:tools", request => {
    request.tools = activeTools();
    request.availableTools = nativeTools().map(tool => tool.name);
  });

  const stopSelection = pi.events.on("piop:mcp:select", selection => {
    try {
      for (const name of registrations.keys()) {
        if (Object.hasOwn(selection.servers, name)) continue;
        pi.unregisterMcpServer(name);
        registrations.delete(name);
      }

      for (const [name, supplied] of Object.entries(selection.servers)) {
        const config = structuredClone(supplied);

        if ("command" in config) {
          const instance = `piop-${createHash("sha256").update(JSON.stringify([selection.sessionId, selection.agentName, name])).digest("hex").slice(0, 32)}`;
          config.env = { PIOP_CUA_INSTANCE_ID: instance, ...config.env };
        }

        const serialized = JSON.stringify(config);

        if (registrations.get(name) === serialized) continue;
        pi.registerMcpServer(name, config);
        registrations.set(name, serialized);
      }

      selection.registered = Promise.resolve(activeTools());
    } catch (error) { selection.registered = Promise.reject(error); }
  });

  pi.on("session_shutdown", () => { stopSelection(); stopTools(); });
}
