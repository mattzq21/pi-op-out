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

type ProviderConfig = Extract<Parameters<ExtensionAPI["registerProvider"]>, [string, unknown]>[1];

/**
 * The provider registration that was in place before a group changed it, and the changes the group made.
 * "native" is the provider object the group registered, if any. "values" are the config values the group set.
 * "restored" is true after the earlier registration was put back.
 */
type ProviderOverride = { before?: ProviderConfig | Provider; native?: Provider; values: Record<string, unknown>; restored?: boolean };

const isNativeProvider = (value: ProviderConfig | Provider | undefined): value is Provider => value !== undefined && "id" in value && typeof value.id === "string" && "auth" in value;

type Registration = { method: "registerTool"; name: string; tool: Tool }
  | { method: "registerCommand"; name: string; command: Command }
  | { method: "registerShortcut"; name: Parameters<ExtensionAPI["registerShortcut"]>[0]; shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] }
  | { method: "registerFlag"; name: string; flag: Parameters<ExtensionAPI["registerFlag"]>[1] }
  | { method: "registerMessageRenderer"; name: string; renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] }
  | { method: "registerEntryRenderer"; name: string; renderer: Parameters<ExtensionAPI["registerEntryRenderer"]>[1] };

type Group = {
  key: string;
  paths: string[];
  registrations: Map<Registration["method"], Map<string, Registration>>;
  providers: Map<string, ProviderOverride>;
  mcpServers: Map<string, Parameters<ExtensionAPI["registerMcpServer"]>[1] | undefined>;
  virtualModels: Map<string, [string, string]>;
  listeners: Array<{ name: string; handler: BusHandler; removed?: boolean; unsubscribe?: () => void }>;
  markdownTransformers: Set<SDK.MarkdownTransformer>;
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

async function directoryEntry(directory: string): Promise<string> {
  for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
    try {
      const candidate = join(directory, name);

      if ((await stat(candidate)).isFile()) return realpath(candidate);
    } catch (error) { if (!Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) throw error; }
  }

  throw new Error("Directory has no index.ts, index.js, index.mjs or index.cjs");
}

export async function resolveExtensionEntry(path: string, parent: string): Promise<string> {
  const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(parent, path);
  let entry = await realpath(absolute);

  if ((await stat(entry)).isDirectory()) entry = await directoryEntry(entry);

  if (!(await stat(entry)).isFile()) throw new Error(`Extension is not a regular file: ${entry}`);
  await access(entry, constants.R_OK);

  return entry;
}

type ExtensionModule = { default: SDK.ExtensionFactory; extensions?: string[] };

export type ExtensionImporter = (entry: string) => Promise<ExtensionModule>;

async function importExtension(entry: string, importer: ExtensionImporter): Promise<ExtensionModule> {
  const module = await importer(entry);

  if (!(module.default instanceof Function)) throw new Error(`Expected a default piop extension factory: ${entry}`);

  return module;
}

export function agentExtensions(pi: ExtensionAPI, baseDirectory: string, importer: ExtensionImporter = path => import(path)) {
  let current: Group | undefined;
  let markdownDispatcher = false;
  const transformMarkdown: SDK.MarkdownTransformer = (markdown, context) => current?.ready
    ? [...current.markdownTransformers].reduce((text, transformer) => transformer(text, context), markdown)
    : markdown;
  const handlerExtensions = new WeakMap<object, string>();
  let registry: ExtensionContext["modelRegistry"] | undefined;
  let latest: ExtensionContext | undefined;
  /** Pi replaces the session model object after provider changes without an event; tell model listeners, such as the context cap. */
  const modelsChanged = () => { if (latest) pi.events.emit("piop:models-refreshed", { ctx: latest }); };
  const registeredProvider = (name: string): ProviderConfig | Provider | undefined => registry?.getRegisteredNativeProvider?.(name) ?? registry?.getRegisteredProviderConfig?.(name);

  /**
   * Puts back the provider that was in place before the group registered its own.
   * Pi merges configs, so a value that another extension set later stays. A value the group set goes back to its earlier value.
   */
  const restoreProvider = (name: string, override: ProviderOverride) => {
    if (override.restored) return;
    restoreRegistration(name, override);
    override.restored = true;
  };

  const restoreRegistration = (name: string, override: ProviderOverride) => {
    const now = registeredProvider(name);

    if (now === undefined) {
      if (isNativeProvider(override.before)) pi.registerProvider(override.before);
      else if (override.before !== undefined) pi.registerProvider(name, override.before);

      return;
    }

    if (isNativeProvider(now)) {
      if (now !== override.native) return;
      pi.unregisterProvider(name);

      if (isNativeProvider(override.before)) pi.registerProvider(override.before);
      else if (override.before !== undefined) pi.registerProvider(name, override.before);

      return;
    }

    const before: Record<string, unknown> = isNativeProvider(override.before) ? {} : { ...override.before };
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(now)) {
      if (!Object.hasOwn(override.values, key) || override.values[key] !== value) result[key] = value;
      else if (before[key] !== undefined) result[key] = before[key];
    }

    for (const [key, value] of Object.entries(before)) if (!(key in result) && value !== undefined) result[key] = value;

    pi.unregisterProvider(name);

    if (isNativeProvider(override.before)) { pi.registerProvider(override.before); return; }

    // Pi requires "api" when "streamSimple" is set. A later "streamSimple" can depend on the "api" that the group set.
    const tries = [result];

    if (result.streamSimple !== undefined && result.api === undefined && now.api !== undefined) tries.push({ ...result, api: now.api });

    if (override.before !== undefined) tries.push({ ...override.before });

    let failure: unknown;

    for (const config of tries) {
      if (Object.keys(config).length === 0) return;

      try { pi.registerProvider(name, config as ProviderConfig); return; } catch (error) { failure = error; }
    }

    throw new Error(`Could not restore provider ${name}: ${String(failure)}`, { cause: failure });
  };

  function channel<A extends unknown[], R>(subscribe: (handler: (...args: A) => R) => () => void, fallback: () => R) {
    const groups = new WeakMap<Group, Set<(...args: A) => R>>();
    const subscriptions = new Map<(...args: A) => R, () => void>();
    const handlers = (group?: Group) => group ? groups.get(group) ?? [] : [];

    const unpublish = () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    };

    const publish = (group: Group) => {
      for (const handler of handlers(group)) {
        if (subscriptions.has(handler)) continue;
        subscriptions.set(handler, subscribe((...args) => current === group ? handler(...args) : fallback()));
      }
    };

    const add = (group: Group, handler: (...args: A) => R) => {
      const list = groups.get(group) ?? new Set<(...args: A) => R>();
      const extension = handlerExtensions.get(handler);
      handler = new Proxy(handler, {});
      if (extension) handlerExtensions.set(handler, extension);
      list.add(handler);
      groups.set(group, list);

      if (group.ready && current === group) publishHandlers(group);

      return () => { list.delete(handler); subscriptions.get(handler)?.(); subscriptions.delete(handler); };
    };

    return { add, publish, handlers, unpublish };
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
  const restoreMcpServer = (group: Group, name: string) => {
    const before = group.mcpServers.get(name);
    if (before) pi.registerMcpServer(name, before);
    else pi.unregisterMcpServer(name);
    group.mcpServers.delete(name);
  };
  const stop = (group: Group | undefined, ctx: ExtensionContext) => {
    if (group) group.ready = false;
    const cleanup = (run: () => void) => {
      try { run(); }
      catch (error) { ctx.ui.notify(`piop extension cleanup failed: ${String(error)}`, "error"); }
    };

    if (group === current) for (const channel of Object.values(channels)) cleanup(channel.unpublish);

    for (const name of group?.mcpServers.keys() ?? []) cleanup(() => restoreMcpServer(group!, name));
    for (const [provider, id] of group?.virtualModels.values() ?? []) cleanup(() => pi.unregisterVirtualModel(provider, id));
    const changed = Boolean(group?.virtualModels.size || group?.providers.size);
    group?.virtualModels.clear();

    for (const [name, override] of group?.providers ?? []) {
      cleanup(() => { restoreProvider(name, override); group!.providers.delete(name); });
    }

    if (changed) cleanup(modelsChanged);

    for (const unsubscribe of group?.stops.splice(0) ?? []) cleanup(unsubscribe);
  };

  const listen = (group: Group) => {
    for (const listener of group.listeners) if (!listener.removed) {
      listener.unsubscribe = pi.events.on(listener.name, (...args) => current === group ? listener.handler(...args) : undefined);
      group.stops.push(listener.unsubscribe);
    }
  };

  async function prepare(paths: string[], ctx: ExtensionContext): Promise<Group> {
    const key = JSON.stringify(paths);

    if (current?.key === key) return current;
    const cached = prepared.get(key);

    if (cached) return cached;
    const group: Group = { key, paths: [...paths], registrations: new Map(), providers: new Map(), mcpServers: new Map(), virtualModels: new Map(), listeners: [], markdownTransformers: new Set(), stops: [], ready: false };
    const loaded = new Set<string>();
    const visiting: string[] = [];
    let failed = false;
    const ensurePreparing = () => {
      if (failed) throw new Error("piop extension initialization has failed");
    };

    const register = (registration: Registration) => {
      ensurePreparing();
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
      registerMarkdownTransformer: (transformer) => {
        ensureActive("registerMarkdownTransformer");
        group.markdownTransformers.add(transformer);

        if (!markdownDispatcher) {
          pi.registerMarkdownTransformer(transformMarkdown);
          markdownDispatcher = true;
        }
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
        const name = args.length === 1 ? args[0].id : args[0];
        const saved = group.providers.get(name);
        const override: ProviderOverride = saved && !saved.restored ? saved : { before: registeredProvider(name), values: {} };

        if (args.length === 1) pi.registerProvider(args[0]);
        else pi.registerProvider(...args);

        if (args.length === 1) { override.native = args[0]; override.values = {}; }
        else {
          if (override.native) { override.native = undefined; override.values = {}; }

          for (const [key, value] of Object.entries(args[1])) if (value !== undefined) override.values[key] = value;
        }

        group.providers.set(name, override);
        modelsChanged();
      },
      unregisterProvider: (...args) => {
        ensureActive("unregisterProvider");
        const override = group.providers.get(args[0]);

        if (override) restoreProvider(args[0], override);
        else pi.unregisterProvider(...args);
        modelsChanged();
      },
      registerMcpServer: (...args) => {
        ensureActive("registerMcpServer");
        const before = pi.getMcpServers().find(server => server.name === args[0])?.config;
        pi.registerMcpServer(...args);
        if (!group.mcpServers.has(args[0])) group.mcpServers.set(args[0], before);
      },
      unregisterMcpServer: (...args) => {
        ensureActive("unregisterMcpServer");

        if (group.mcpServers.has(args[0])) restoreMcpServer(group, args[0]);
        else throw new Error(`piop extension does not own MCP server: ${args[0]}`);
      },
      getMcpServers: (...args) => {
        ensureActive("getMcpServers");

        return pi.getMcpServers(...args);
      },
      registerVirtualModel: (...args) => {
        ensureActive("registerVirtualModel");
        const { provider, id } = args[0];
        const key = JSON.stringify([provider, id]);
        if (!group.virtualModels.has(key) && registry?.find(provider, id)) throw new Error(`piop extension virtual model conflicts with an existing model: ${provider}/${id}`);
        pi.registerVirtualModel(...args);
        group.virtualModels.set(key, [provider, id]);
        modelsChanged();
      },
      unregisterVirtualModel: (...args) => {
        ensureActive("unregisterVirtualModel");

        const key = JSON.stringify(args);
        if (!group.virtualModels.has(key)) throw new Error(`piop extension does not own virtual model: ${args.join("/")}`);
        pi.unregisterVirtualModel(...args);
        group.virtualModels.delete(key);
        modelsChanged();
      },
    };

    const isForwarded = (property: PropertyKey): property is keyof typeof forwardingApi => Object.hasOwn(forwardingApi, property);

    const api = (entry: string) => new Proxy(pi, {
      get(_target, property) {
        if (property === "on") return <K extends keyof EventHandlers>(event: K, handler: EventHandlers[K]) => {
          ensurePreparing();
          if (event !== "session_start" && event !== "session_shutdown") return eventRegistrations[event].add(group, handler);
          const owned = new Proxy(handler, {});
          handlerExtensions.set(owned, entry);

          return eventRegistrations[event].add(group, owned);
        };

        if (property === "events") return {
          on(name: string, handler: BusHandler) {
            ensurePreparing();
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
      const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(parent, path);

      try {
        const entry = await resolveExtensionEntry(path, parent);

        if (visiting.includes(entry)) throw new Error(`Circular piop extension dependency: ${[...visiting, entry].join(" -> ")}`);

        if (loaded.has(entry)) return;
        visiting.push(entry);
        const module = await runHandler(entry, "import", ctx, () => importExtension(entry, importer));

        for (const dependency of extensionPaths(module.extensions)) await load(dependency, dirname(entry));
        await runHandler(entry, "initialization", ctx, () => module.default(api(entry)));
        visiting.pop(); loaded.add(entry);
      } catch (error) {
        throw new Error(`Could not load piop extension ${absolute}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    try {
      for (const path of paths) await load(path, baseDirectory);
      validateConflicts(group);
    } catch (error) {
      failed = true;
      group.ready = true;
      await shutdown(group, ctx);
      stop(group, ctx);
      throw error;
    }
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

  async function runHandler<T>(extension: string, phase: "import" | "initialization" | "startup" | "shutdown", ctx: ExtensionContext, run: (ctx: ExtensionContext) => T) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = phase === "shutdown" ? 10000 : 60000;
    const controller = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;

    const pending = Promise.resolve().then(() => run(new Proxy(ctx, {
      get: (target, property, receiver) => property === "signal" ? signal : Reflect.get(target, property, receiver),
    })));

    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`${phase === "import" || phase === "initialization" ? phase : "handler"} timed out after ${timeout} ms`);
            reject(error);
            controller.abort(error);
          }, timeout);
        }),
        pending,
      ]);
    } catch (error) {
      if ((phase === "import" || phase === "initialization") && controller.signal.aborted) {
        void pending.catch(error => ctx.ui.notify(`piop extension ${extension} ${phase} failed after timeout: ${String(error)}`, "error"));
      }
      if (phase === "startup" && controller.signal.aborted) {
        clearTimeout(timer);
        const settled = await Promise.race([
          pending.then(() => true, () => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10000); }),
        ]);

        if (!settled) ctx.ui.notify(`piop extension ${extension} startup handler has not settled 10000 ms after abort; proceeding with cleanup`, "error");
      }

      throw new Error(`piop extension ${extension} ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { clearTimeout(timer); }
  }

  async function start(group: Group, ctx: ExtensionContext) {
    for (const handler of channels.session_start.handlers(group)) {
      if (!handler) continue;
      const extension = handlerExtensions.get(handler)!;
      await runHandler(extension, "startup", ctx, context => handler({ type: "session_start", reason: "reload" }, context));
    }
  }

  function hideInactiveTools(group: Group | undefined, activeGroup: Group | undefined) {
    const activeTools = new Set(tools(activeGroup));

    for (const [name, item] of group?.registrations.get("registerTool") ?? []) {
      if (activeTools.has(name)) continue;

      if (item.method === "registerTool") pi.registerTool({ ...item.tool, exposure: "hidden", execute: async () => { throw new Error(`piop extension tool is inactive: ${name}`); } });
    }
  }

  async function shutdown(group: Group | undefined, ctx: ExtensionContext, event: SDK.SessionShutdownEvent = { type: "session_shutdown", reason: "reload" }) {
    const active = current;
    current = group;
    registry = ctx.modelRegistry;
    latest = ctx;

    const errors: unknown[] = [];

    try {
      for (const handler of channels.session_shutdown.handlers(group)) {
        if (!handler) continue;
        const extension = handlerExtensions.get(handler)!;

        try { await runHandler(extension, "shutdown", ctx, context => handler(event, context)); }
        catch (error) { errors.push(error); }
      }
    } finally { current = active; }

    for (const error of errors) ctx.ui.notify(`piop extension cleanup failed: ${String(error)}`, "error");
  }

  async function activate(group: Group, ctx: ExtensionContext) {
    const session = ctx.sessionManager.getSessionId();
    registry = ctx.modelRegistry;
    latest = ctx;

    if (group === current && group.session === session) return;

    if (group === current) {
      try { await start(group, ctx); group.session = session; }
      catch (error) {
        await shutdown(group, ctx);
        stop(group, ctx); current = undefined;
        hideInactiveTools(group, undefined);
        throw error;
      }

      return;
    }

    prepared.delete(group.key);
    const previous = current;
    await shutdown(previous, ctx);
    stop(previous, ctx);
    current = group; group.ready = true;

    try {
      publishHandlers(group);

      for (const items of group.registrations.values()) for (const registration of items.values()) publishRegistration(registration);
      listen(group);
      await start(group, ctx);
      group.session = session;
      hideInactiveTools(previous, group);
    } catch (error) {
      await shutdown(group, ctx);
      stop(group, ctx); current = undefined;
      hideInactiveTools(group, previous);

      if (previous) {
        try { await activate(await prepare(previous.paths, ctx), ctx); }
        catch (error) { hideInactiveTools(group, undefined); hideInactiveTools(previous, undefined); ctx.ui.notify(`piop extension restart failed: ${String(error)}`, "error"); }
      }

      throw error;
    }
  }

  /**
   * Runs the shutdown handlers of the active group, then removes its providers and listeners.
   * With no event, the group is also unloaded for a reload and its tools are hidden.
   */
  async function deactivate(ctx: ExtensionContext, event?: SDK.SessionShutdownEvent) {
    const group = current;

    if (!group) return;

    try { await shutdown(group, ctx, event); }
    finally {
      stop(group, ctx);

      if (current === group) current = undefined;

      if (!event) hideInactiveTools(group, undefined);
    }
  }

  return { prepare, activate, tools, deactivate };
}
