import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type * as SDK from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const extensionPathsSchema = Type.Array(Type.String({ pattern: "\\S" }));

const eventDataSchema = Type.Unknown();

type BusHandler = (data: Static<typeof eventDataSchema>) => void;

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type Registration = { method: "registerTool"; name: string; tool: Tool }
  | { method: "registerCommand"; name: string; command: Command }
  | { method: "registerShortcut"; name: Parameters<ExtensionAPI["registerShortcut"]>[0]; shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] }
  | { method: "registerFlag"; name: string; flag: Parameters<ExtensionAPI["registerFlag"]>[1] }
  | { method: "registerMessageRenderer"; name: string; renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] }
  | { method: "registerEntryRenderer"; name: string; renderer: Parameters<ExtensionAPI["registerEntryRenderer"]>[1] };

type Group = {
  key: string;
  registrations: Map<Registration["method"], Map<string, Registration>>;
  listeners: Array<{ name: string; handler: BusHandler; removed?: boolean; unsubscribe?: () => void }>;
  stops: Array<() => void>;
  ready: boolean;
  session?: string;
};

export function extensionPaths(value: string[] | undefined): string[] {
  if (value === undefined) return [];

  if (!Check(extensionPathsSchema, value)) {
    throw new Error("piop extensions must be an array of nonempty file or directory paths");
  }

  return [...new Set(value.map(path => path.trim()))];
}

function bundledPath(path: string, parent: string, base: string) {
  return path === "../piop-diagrams.ts" && parent === base && process.env.PIOP_GENERATED_EXTENSION_ROOT ? join(process.env.PIOP_GENERATED_EXTENSION_ROOT, "piop-diagrams.ts") : path;
}

async function directoryEntry(directory: string): Promise<string> {
  for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
    try {
      const candidate = join(directory, name);

      if ((await stat(candidate)).isFile()) return realpath(candidate);
    } catch (error) { if (!Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) throw error; }
  }

  throw new Error("Directory has no index.ts, index.js, index.mjs or index.cjs");
}

export async function resolveExtensionEntry(path: string, parent: string, base: string): Promise<string> {
  path = bundledPath(path, parent, base);
  const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(parent, path);
  let entry = await realpath(absolute);

  if ((await stat(entry)).isDirectory()) entry = await directoryEntry(entry);

  if (!(await stat(entry)).isFile()) throw new Error(`Extension is not a regular file: ${entry}`);
  await access(entry, constants.R_OK);

  return entry;
}

export function agentExtensions(pi: ExtensionAPI, baseDirectory: string) {
  let current: Group | undefined;

  function channel<A extends unknown[], R>(subscribe: (handler: (...args: A) => R) => () => void, fallback: () => R) {
    const groups = new WeakMap<Group, Array<((...args: A) => R) | undefined>>();
    let dispatched = 0;
    const handlers = (group?: Group) => group ? groups.get(group) ?? [] : [];

    const publish = (group: Group) => {
      for (; dispatched < handlers(group).length; dispatched++) {
        const index = dispatched;
        subscribe((...args) => {
          const handler = handlers(current)[index];

          return handler ? handler(...args) : fallback();
        });
      }
    };

    const add = (group: Group, handler: (...args: A) => R) => {
      const list = groups.get(group) ?? [];
      const index = list.push(handler) - 1;
      groups.set(group, list);

      if (group.ready && current === group) publishHandlers(group);

      return () => { list[index] = undefined; };
    };

    return { add, publish, handlers };
  }

  const extensionChannel = <E, R = undefined>(subscribe: (handler: SDK.ExtensionHandler<E, R>) => () => void) =>
    channel<[E, ExtensionContext], ReturnType<SDK.ExtensionHandler<E, R>>>(subscribe, () => undefined);

  const channels = {
    project_trust: channel<Parameters<SDK.ProjectTrustHandler>, ReturnType<SDK.ProjectTrustHandler>>(handler => pi.on("project_trust", handler), () => ({ trusted: "undecided" })),
    resources_discover: extensionChannel<SDK.ResourcesDiscoverEvent, SDK.ResourcesDiscoverResult>(handler => pi.on("resources_discover", handler)),
    session_start: extensionChannel<SDK.SessionStartEvent>(handler => pi.on("session_start", handler)),
    session_info_changed: extensionChannel<SDK.SessionInfoChangedEvent>(handler => pi.on("session_info_changed", handler)),
    session_before_switch: extensionChannel<SDK.SessionBeforeSwitchEvent, SDK.SessionBeforeSwitchResult>(handler => pi.on("session_before_switch", handler)),
    session_before_fork: extensionChannel<SDK.SessionBeforeForkEvent, SDK.SessionBeforeForkResult>(handler => pi.on("session_before_fork", handler)),
    session_before_compact: extensionChannel<SDK.SessionBeforeCompactEvent, SDK.SessionBeforeCompactResult>(handler => pi.on("session_before_compact", handler)),
    session_compact: extensionChannel<SDK.SessionCompactEvent>(handler => pi.on("session_compact", handler)),
    session_compact_failed: extensionChannel<SDK.SessionCompactFailedEvent>(handler => pi.on("session_compact_failed", handler)),
    session_shutdown: extensionChannel<SDK.SessionShutdownEvent>(handler => pi.on("session_shutdown", handler)),
    mcp_servers_change: extensionChannel<SDK.McpServersChangeEvent>(handler => pi.on("mcp_servers_change", handler)),
    session_before_tree: extensionChannel<SDK.SessionBeforeTreeEvent, SDK.SessionBeforeTreeResult>(handler => pi.on("session_before_tree", handler)),
    session_tree: extensionChannel<SDK.SessionTreeEvent>(handler => pi.on("session_tree", handler)),
    context: extensionChannel<SDK.ContextEvent, SDK.ContextEventResult>(handler => pi.on("context", handler)),
    context_with_system: extensionChannel<SDK.ContextWithSystemEvent, SDK.ContextEventResult>(handler => pi.on("context_with_system", handler)),
    cache_warming_decision: extensionChannel<SDK.CacheWarmingDecisionEvent, SDK.CacheWarmingDecisionEventResult>(handler => pi.on("cache_warming_decision", handler)),
    before_provider_request: extensionChannel<SDK.BeforeProviderRequestEvent, SDK.BeforeProviderRequestEventResult>(handler => pi.on("before_provider_request", handler)),
    before_provider_headers: extensionChannel<SDK.BeforeProviderHeadersEvent>(handler => pi.on("before_provider_headers", handler)),
    after_provider_response: extensionChannel<SDK.AfterProviderResponseEvent>(handler => pi.on("after_provider_response", handler)),
    provider_stream_event: extensionChannel<SDK.ProviderStreamEvent>(handler => pi.on("provider_stream_event", handler)),
    before_agent_start: extensionChannel<SDK.BeforeAgentStartEvent, SDK.BeforeAgentStartEventResult>(handler => pi.on("before_agent_start", handler)),
    agent_start: extensionChannel<SDK.AgentStartEvent>(handler => pi.on("agent_start", handler)),
    agent_end: extensionChannel<SDK.AgentEndEvent>(handler => pi.on("agent_end", handler)),
    agent_before_settle: extensionChannel<SDK.AgentBeforeSettleEvent, SDK.AgentBeforeSettleEventResult>(handler => pi.on("agent_before_settle", handler)),
    agent_settled: extensionChannel<SDK.AgentSettledEvent>(handler => pi.on("agent_settled", handler)),
    ui_prompt_start: extensionChannel<SDK.UIPromptStartEvent>(handler => pi.on("ui_prompt_start", handler)),
    ui_prompt_end: extensionChannel<SDK.UIPromptEndEvent>(handler => pi.on("ui_prompt_end", handler)),
    turn_start: extensionChannel<SDK.TurnStartEvent>(handler => pi.on("turn_start", handler)),
    turn_end: extensionChannel<SDK.TurnEndEvent, SDK.TurnEndEventResult>(handler => pi.on("turn_end", handler)),
    message_start: extensionChannel<SDK.MessageStartEvent>(handler => pi.on("message_start", handler)),
    message_update: extensionChannel<SDK.MessageUpdateEvent>(handler => pi.on("message_update", handler)),
    message_end: extensionChannel<SDK.MessageEndEvent, SDK.MessageEndEventResult>(handler => pi.on("message_end", handler)),
    tool_execution_start: extensionChannel<SDK.ToolExecutionStartEvent>(handler => pi.on("tool_execution_start", handler)),
    tool_execution_update: extensionChannel<SDK.ToolExecutionUpdateEvent>(handler => pi.on("tool_execution_update", handler)),
    tool_execution_end: extensionChannel<SDK.ToolExecutionEndEvent>(handler => pi.on("tool_execution_end", handler)),
    model_select: extensionChannel<SDK.ModelSelectEvent>(handler => pi.on("model_select", handler)),
    thinking_level_select: extensionChannel<SDK.ThinkingLevelSelectEvent>(handler => pi.on("thinking_level_select", handler)),
    tool_call: extensionChannel<SDK.ToolCallEvent, SDK.ToolCallEventResult>(handler => pi.on("tool_call", handler)),
    tool_result: extensionChannel<SDK.ToolResultEvent, SDK.ToolResultEventResult>(handler => pi.on("tool_result", handler)),
    user_bash: extensionChannel<SDK.UserBashEvent, SDK.UserBashEventResult>(handler => pi.on("user_bash", handler)),
    input: extensionChannel<SDK.InputEvent, SDK.InputEventResult>(handler => pi.on("input", handler)),
  };

  type EventHandlers = { [K in keyof typeof channels]: Parameters<typeof channels[K]["add"]>[1] };

  type EventRegistrations = { [K in keyof EventHandlers]: { add: (group: Group, handler: EventHandlers[K]) => () => void } };

  const eventRegistrations: EventRegistrations = channels;
  const prepared = new Map<string, Group>();
  const dispatchedCommands = new Set<string>();
  const managedTools = new Set<string>();
  const tools = (group = current): string[] => [...(group?.registrations.get("registerTool")?.keys() ?? [])];
  const stop = (group?: Group) => { for (const unsubscribe of group?.stops.splice(0) ?? []) unsubscribe(); };

  const listen = (group: Group) => {
    for (const listener of group.listeners) if (!listener.removed) {
      listener.unsubscribe = pi.events.on(listener.name, (...args) => current === group ? listener.handler(...args) : undefined);
      group.stops.push(listener.unsubscribe);
    }
  };

  async function prepare(paths: string[]): Promise<Group> {
    const key = JSON.stringify(paths);

    if (current?.key === key) return current;
    const cached = prepared.get(key);

    if (cached) return cached;
    const group: Group = { key, registrations: new Map(), listeners: [], stops: [], ready: false };
    const loaded = new Set<string>();
    const visiting: string[] = [];

    const register = (registration: Registration) => {
      if (group.ready) throw new Error("piop extensions must register resources during initialization");
      const items = group.registrations.get(registration.method) ?? new Map<string, Registration>();

      if (items.has(registration.name)) throw new Error(`Duplicate piop extension registration: ${registration.method} ${registration.name}`);
      items.set(registration.name, registration); group.registrations.set(registration.method, items);
    };

    const registrationApi = {
      registerTool: (tool: Tool) => register({ method: "registerTool", name: tool.name, tool }),
      registerCommand: (...[name, command]: Parameters<ExtensionAPI["registerCommand"]>) => register({ method: "registerCommand", name, command }),
      registerShortcut: (...[name, shortcut]: Parameters<ExtensionAPI["registerShortcut"]>) => register({ method: "registerShortcut", name, shortcut }),
      registerFlag: (...[name, flag]: Parameters<ExtensionAPI["registerFlag"]>) => register({ method: "registerFlag", name, flag }),
      registerMessageRenderer: (...[name, renderer]: Parameters<ExtensionAPI["registerMessageRenderer"]>) => register({ method: "registerMessageRenderer", name, renderer }),
      registerEntryRenderer: (...[name, renderer]: Parameters<ExtensionAPI["registerEntryRenderer"]>) => register({ method: "registerEntryRenderer", name, renderer }),
    };

    const isRegistration = (property: PropertyKey): property is keyof typeof registrationApi => Object.hasOwn(registrationApi, property);

    const ensureActive = (method: string) => {
      if (!group.ready || current !== group) throw new Error(`piop extension API ${method} is unavailable before activation or after deactivation`);
    };

    const forwardingApi: Pick<ExtensionAPI, "getFlag" | "registerMarkdownTransformer" | "sendMessage" | "sendUserMessage" | "appendEntry" | "setSessionName" | "getSessionName" | "setLabel" | "exec" | "getActiveTools" | "getAllTools" | "getSettings" | "setActiveTools" | "getCommands" | "setModel" | "getThinkingLevel" | "setThinkingLevel" | "registerProvider" | "unregisterProvider" | "registerMcpServer" | "unregisterMcpServer" | "getMcpServers" | "registerVirtualModel" | "unregisterVirtualModel"> = {
      getFlag: (...args) => {
        ensureActive("getFlag");

        return pi.getFlag(...args);
      },
      registerMarkdownTransformer: (...args) => {
        ensureActive("registerMarkdownTransformer");

        return pi.registerMarkdownTransformer(...args);
      },
      sendMessage: (...args) => {
        ensureActive("sendMessage");

        return pi.sendMessage(...args);
      },
      sendUserMessage: (...args) => {
        ensureActive("sendUserMessage");

        return pi.sendUserMessage(...args);
      },
      appendEntry: (...args) => {
        ensureActive("appendEntry");

        return pi.appendEntry(...args);
      },
      setSessionName: (...args) => {
        ensureActive("setSessionName");

        return pi.setSessionName(...args);
      },
      getSessionName: (...args) => {
        ensureActive("getSessionName");

        return pi.getSessionName(...args);
      },
      setLabel: (...args) => {
        ensureActive("setLabel");

        return pi.setLabel(...args);
      },
      exec: (...args) => {
        ensureActive("exec");

        return pi.exec(...args);
      },
      getActiveTools: (...args) => {
        ensureActive("getActiveTools");

        return pi.getActiveTools(...args);
      },
      getAllTools: (...args) => {
        ensureActive("getAllTools");

        return pi.getAllTools(...args);
      },
      getSettings: (...args) => {
        ensureActive("getSettings");

        return pi.getSettings(...args);
      },
      setActiveTools: (...args) => {
        ensureActive("setActiveTools");

        return pi.setActiveTools(...args);
      },
      getCommands: (...args) => {
        ensureActive("getCommands");

        return pi.getCommands(...args);
      },
      setModel: (...args) => {
        ensureActive("setModel");

        return pi.setModel(...args);
      },
      getThinkingLevel: (...args) => {
        ensureActive("getThinkingLevel");

        return pi.getThinkingLevel(...args);
      },
      setThinkingLevel: (...args) => {
        ensureActive("setThinkingLevel");

        return pi.setThinkingLevel(...args);
      },
      registerProvider: (...args: [Provider] | Parameters<ExtensionAPI["registerProvider"]>) => {
        ensureActive("registerProvider");

        if (args.length === 1) pi.registerProvider(args[0]);
        else pi.registerProvider(...args);
      },
      unregisterProvider: (...args) => {
        ensureActive("unregisterProvider");

        return pi.unregisterProvider(...args);
      },
      registerMcpServer: (...args) => {
        ensureActive("registerMcpServer");

        return pi.registerMcpServer(...args);
      },
      unregisterMcpServer: (...args) => {
        ensureActive("unregisterMcpServer");

        return pi.unregisterMcpServer(...args);
      },
      getMcpServers: (...args) => {
        ensureActive("getMcpServers");

        return pi.getMcpServers(...args);
      },
      registerVirtualModel: (...args) => {
        ensureActive("registerVirtualModel");

        return pi.registerVirtualModel(...args);
      },
      unregisterVirtualModel: (...args) => {
        ensureActive("unregisterVirtualModel");

        return pi.unregisterVirtualModel(...args);
      },
    };

    const isForwarded = (property: PropertyKey): property is keyof typeof forwardingApi => Object.hasOwn(forwardingApi, property);

    const api = new Proxy(pi, {
      get(_target, property) {
        if (property === "on") return <K extends keyof EventHandlers>(event: K, handler: EventHandlers[K]) => eventRegistrations[event].add(group, handler);

        if (property === "events") return {
          on(name: string, handler: BusHandler) {
            const listener: Group["listeners"][number] = { name, handler, removed: false }; group.listeners.push(listener);
            let unsubscribe: (() => void) | undefined;

            if (group.ready && current === group) { unsubscribe = pi.events.on(name, handler); group.stops.push(unsubscribe); }

            return () => { listener.removed = true; unsubscribe?.(); listener.unsubscribe?.(); };
          },
          emit<T>(name: string, value: T) {
            if (!group.ready || current !== group) throw new Error("piop extension events may only be emitted after activation");

            return pi.events.emit(name, value);
          },
        };

        if (isRegistration(property)) return registrationApi[property];

        if (property === "getFlag" && !group.ready) return (name: string) => {
          const item = group.registrations.get("registerFlag")?.get(name);

          return item?.method === "registerFlag" ? item.flag.default : undefined;
        };

        return isForwarded(property) ? forwardingApi[property] : undefined;
      }
    });

    async function load(path: string, parent: string) {
      path = bundledPath(path, parent, baseDirectory);
      const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(parent, path);

      try {
        const entry = await resolveExtensionEntry(path, parent, baseDirectory);

        if (visiting.includes(entry)) throw new Error(`Circular piop extension dependency: ${[...visiting, entry].join(" -> ")}`);

        if (loaded.has(entry)) return;
        visiting.push(entry);
        const module = await import(entry);

        if (!(module.default instanceof Function)) throw new Error("Expected a default piop extension factory");

        for (const dependency of extensionPaths(module.extensions)) await load(dependency, dirname(entry));
        await module.default(api);
        visiting.pop(); loaded.add(entry);
      } catch (error) {
        throw new Error(`Could not load piop extension ${absolute}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    for (const path of paths) await load(path, baseDirectory);
    validateConflicts(group);
    prepared.set(key, group);

    return group;
  }

  function validateConflicts(group: Group) {
    const available = new Set(pi.getAllTools().map(tool => tool.name));

    for (const name of tools(group)) if (available.has(name) && !managedTools.has(name)) throw new Error(`piop extension tool conflicts with an existing tool: ${name}`);

    for (const name of group.registrations.get("registerCommand")?.keys() ?? []) {
      if (!dispatchedCommands.has(name) && pi.getCommands().some(command => command.name === name)) throw new Error(`piop extension command conflicts with an existing command: ${name}`);
    }
  }

  function publishHandlers(group: Group) {
    for (const [event, registered] of Object.entries(channels)) {
      if (event !== "session_start") registered.publish(group);
    }
  }

  function publishRegistration(registration: Registration) {
    const { method, name } = registration;

    if (registration.method === "registerCommand") {
      dispatchedCommands.add(name);
      pi.registerCommand(name, {
        ...registration.command, handler: (...values: Parameters<Command["handler"]>) => {
          const item = current?.registrations.get(method)?.get(name);

          if (item?.method !== "registerCommand") throw new Error(`piop extension command is inactive: ${name}`);

          return item.command.handler(...values);
        }
      });
    } else if (registration.method === "registerTool") {
      managedTools.add(name);
      pi.registerTool({
        ...registration.tool, execute: (...values: Parameters<Tool["execute"]>) => {
          const item = current?.registrations.get(method)?.get(name);

          if (item?.method !== "registerTool") throw new Error(`piop extension tool is inactive: ${name}`);

          return item.tool.execute(...values);
        }
      });
    } else publishStaticRegistration(registration);
  }

  function publishStaticRegistration(registration: Exclude<Registration, { method: "registerTool" | "registerCommand" }>) {
    if (registration.method === "registerShortcut") {
      pi.registerShortcut(registration.name, { ...registration.shortcut, handler: (...values) => {
        const item = current?.registrations.get("registerShortcut")?.get(registration.name);

        return item?.method === "registerShortcut" ? item.shortcut.handler(...values) : undefined;
      } });
    } else if (registration.method === "registerFlag") pi.registerFlag(registration.name, registration.flag);
    else if (registration.method === "registerMessageRenderer") pi.registerMessageRenderer(registration.name, registration.renderer);
    else pi.registerEntryRenderer(registration.name, registration.renderer);
  }

  async function start(group: Group, ctx: ExtensionContext) {
    for (const handler of channels.session_start.handlers(group)) await handler?.({ type: "session_start", reason: "reload" }, ctx);
  }

  function hideInactiveTools(group: Group | undefined, activeGroup: Group | undefined) {
    const activeTools = new Set(tools(activeGroup));

    for (const [name, item] of group?.registrations.get("registerTool") ?? []) {
      if (activeTools.has(name)) continue;

      if (item.method === "registerTool") pi.registerTool({ ...item.tool, exposure: "hidden", execute: async () => { throw new Error(`piop extension tool is inactive: ${name}`); } });
    }
  }

  async function shutdown(group: Group | undefined, ctx: ExtensionContext) {
    const active = current;
    current = group;

    try {
      for (const handler of channels.session_shutdown.handlers(group)) {
        try { await handler?.({ type: "session_shutdown", reason: "reload" }, ctx); }
        catch (error) { ctx.ui.notify(`piop extension cleanup failed: ${String(error)}`, "error"); }
      }
    } finally { current = active; }
  }

  function republishTools(group: Group | undefined) {
    for (const item of group?.registrations.get("registerTool")?.values() ?? []) publishRegistration(item);
  }

  async function activate(group: Group, ctx: ExtensionContext) {
    const session = ctx.sessionManager.getSessionId();

    if (group === current && group.session === session) return;

    if (group === current) { await start(group, ctx); group.session = session;

    return; }

    prepared.delete(group.key);
    const previous = current;
    current = group; group.ready = true;

    try {
      publishHandlers(group);

      for (const items of group.registrations.values()) for (const registration of items.values()) publishRegistration(registration);
      listen(group);
      await start(group, ctx);
      group.session = session;
      await shutdown(previous, ctx);
      stop(previous);
      hideInactiveTools(previous, group);
    } catch (error) {
      await shutdown(group, ctx);
      stop(group); current = previous;
      hideInactiveTools(group, previous);

      republishTools(previous);
      throw error;
    }
  }

  return { prepare, activate, tools, stop: () => stop(current) };
}
