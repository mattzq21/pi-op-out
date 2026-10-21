import { z } from "zod";
import type { TSchema } from "typebox";
import { createMcpExtension, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type ExtensionHandler, type McpServerConfig, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type Selection = { servers: Record<string, McpServerConfig & { piopInjectAgentId?: boolean }>; codemode?: "on" | "off"; sessionId: string; registered?: Promise<string[]> };

type ToolRequest = { tools?: string[]; availableTools?: string[] };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:mcp:select", handler: (selection: Selection) => void): () => void;
    emit(channel: "piop:mcp:select", selection: Selection): void;
    on(channel: "piop:mcp:tools", handler: (request: ToolRequest) => void): () => void;
    emit(channel: "piop:mcp:tools", request: ToolRequest): void;
  }
}

function withAgentIdentity<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>, instance: string | undefined): ToolDefinition<TParams, TDetails, TState> {
  const schema = z.object({ properties: z.record(z.string(), z.json()), required: z.array(z.string()).optional() }).safeParse(tool.parameters);

  if (!instance || !schema.success || !z.object({ type: z.literal("string") }).safeParse(schema.data.properties.agent_id).success) return tool;
  const parameters: TParams = { ...tool.parameters, properties: Object.fromEntries(Object.entries(schema.data.properties).filter(([key]) => key !== "agent_id")) };

  if (schema.data.required) Object.assign(parameters, { required: schema.data.required.filter(key => key !== "agent_id") });

  return {
    ...tool,
    parameters,
    execute(id, params, signal, onUpdate, ctx) {
      return tool.execute(id, Object.assign({}, params, { agent_id: instance }), signal, onUpdate, ctx);
    },
  };
}

export default function agentMcp(pi: ExtensionAPI) {
  const registrations = new Map<string, string>();
  const identities = new Map<string, string>();
  const nativeToolNames = new Set<string>();
  let started = false;
  let codemodeEnabled = true;
  let sessionStart: SessionStartEvent = { type: "session_start", reason: "startup" };
  let start: ExtensionHandler<SessionStartEvent> | undefined;

  const ensureStarted = async (ctx: ExtensionContext) => {
    if (started) return;
    started = true;

    try { await start?.(sessionStart, ctx); }
    catch (error) { started = false; throw error; }
  };

  pi.on("session_start", event => { started = false; sessionStart = event; });
  pi.on("input", (_event, ctx) => ensureStarted(ctx));
  pi.on("before_agent_start", (_event, ctx) => ensureStarted(ctx));
  const subscribe = pi.on as (event: ExtensionEvent["type"], handler: ExtensionHandler<never, unknown>) => () => void;
  createMcpExtension()({
    ...pi,
    registerCommand() {},
    setActiveTools(names) {
      pi.setActiveTools(names.filter(name => codemodeEnabled || name !== "codemode"));
    },
    on(event, handler) {
      if (event === "session_start") {
        start = handler as ExtensionHandler<SessionStartEvent>;

        return () => { start = undefined; };
      }

      return subscribe(event, handler);
    },
    registerTool(tool) {
      nativeToolNames.add(tool.name);
      pi.registerTool(withAgentIdentity(tool, identities.get(tool.namespace?.name ?? "")));
    },
  });

  const nativeTools = () => pi.getAllTools().filter(tool =>
    tool.exposure !== "hidden" && (nativeToolNames.has(tool.name) || ["builtin:mcp", "builtin:codemode", "builtin:tool-search"].includes(tool.sourceInfo?.path ?? "")));

  const activeTools = () => {
    const active = new Set(pi.getActiveTools());

    return nativeTools().filter(tool => tool.name === "codemode" ? codemodeEnabled : active.has(tool.name)).map(tool => tool.name);
  };

  const stopTools = pi.events.on("piop:mcp:tools", request => {
    request.tools = activeTools();
    request.availableTools = nativeTools().map(tool => tool.name);
  });

  const stopSelection = pi.events.on("piop:mcp:select", selection => {
    try {
      codemodeEnabled = selection.codemode !== "off";

      if (!codemodeEnabled) pi.setActiveTools(pi.getActiveTools().filter(name => name !== "codemode"));

      for (const name of registrations.keys()) {
        if (Object.hasOwn(selection.servers, name)) continue;
        pi.unregisterMcpServer(name);
        registrations.delete(name);
        identities.delete(`mcp__${name.replaceAll("-", "_")}`);
      }

      for (const [name, supplied] of Object.entries(selection.servers)) {
        const { piopInjectAgentId, ...config } = structuredClone(supplied);
        const instance = selection.sessionId;
        const namespace = `mcp__${name.replaceAll("-", "_")}`;
        // The agent's codemode choice decides how MCP tools are reached: through codemode, or directly when codemode is off.
        config.exposure = codemodeEnabled ? "codemode" : "direct";
        delete config.toolExposure;

        if (piopInjectAgentId) identities.set(namespace, instance); else identities.delete(namespace);

        if ("command" in config) {
          config.env = { PIOP_CUA_INSTANCE_ID: instance, ...config.env };
        }

        const serialized = JSON.stringify([config, piopInjectAgentId, instance]);

        if (registrations.get(name) === serialized) continue;

        if (registrations.has(name)) pi.unregisterMcpServer(name);
        pi.registerMcpServer(name, config);
        registrations.set(name, serialized);
      }

      selection.registered = Promise.resolve(activeTools());
    } catch (error) { selection.registered = Promise.reject(error); }
  });

  pi.on("session_shutdown", () => { stopSelection(); stopTools(); });
}
