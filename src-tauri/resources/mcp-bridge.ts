import { createHash } from "node:crypto";
import { createMcpExtension, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type ExtensionHandler, type InputEvent, type McpServerConfig, type SessionStartEvent } from "@earendil-works/pi-coding-agent";

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
  const nativeToolNames = new Set<string>();
  let started = false;
  let sessionStart: SessionStartEvent = { type: "session_start", reason: "startup" };
  let start: ExtensionHandler<SessionStartEvent> | undefined;

  const startOnMessage = async (_event: InputEvent | BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (started) return;
    started = true;

    try { await start?.(sessionStart, ctx); }
    catch (error) { started = false; throw error; }
  };

  pi.on("session_start", event => { started = false; sessionStart = event; });
  pi.on("input", startOnMessage);
  pi.on("before_agent_start", startOnMessage);
  // eslint-disable-next-line local/no-assertions -- Forward pi's overloaded event/handler pair unchanged.
  const subscribe = pi.on as (event: ExtensionEvent["type"], handler: ExtensionHandler<never, unknown>) => () => void;
  createMcpExtension()({
    ...pi,
    on(event, handler) {
      if (event === "session_start") {
        // eslint-disable-next-line local/no-assertions -- The event discriminates pi's matching handler overload.
        start = handler as ExtensionHandler<SessionStartEvent>;

        return () => { start = undefined; };
      }

      return subscribe(event, handler);
    },
    registerTool(tool) {
      nativeToolNames.add(tool.name);
      pi.registerTool(tool);
    },
  });

  const nativeTools = () => pi.getAllTools().filter(tool =>
    tool.exposure !== "hidden" && (nativeToolNames.has(tool.name) || ["builtin:mcp", "builtin:codemode", "builtin:tool-search"].includes(tool.sourceInfo?.path ?? "")));

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
