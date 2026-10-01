import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (...args: unknown[]) => unknown;

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type Group = {
  key: string;
  handlers: Map<string, Handler[]>;
  registrations: Map<string, Map<string, unknown[]>>;
  listeners: Array<{ name: string; handler: Handler; removed?: boolean; unsubscribe?: () => void }>;
  stops: Array<() => void>;
  ready: boolean;
  session?: string;
};

export function extensionPaths(value: unknown): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value) || value.some(path => typeof path !== "string" || !path.trim())) {
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
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  throw new Error("Directory has no index.ts, index.js, index.mjs or index.cjs");
}

export function agentExtensions(pi: ExtensionAPI, baseDirectory: string) {
  let current: Group | undefined;
  const dispatchedEvents = new Map<string, number>();
  const prepared = new Map<string, Group>();
  const dispatchedCommands = new Set<string>();
  const managedTools = new Set<string>();
  const registrations = new Set(["registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer"]);
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
    const group: Group = { key, handlers: new Map(), registrations: new Map(), listeners: [], stops: [], ready: false };
    const loaded = new Set<string>();
    const visiting: string[] = [];

    const api = new Proxy(pi, {
      get(target, property) {
        if (property === "on") return (event: string, handler: Handler) => {
          const list = group.handlers.get(event) ?? []; list.push(handler); group.handlers.set(event, list);

          if (group.ready && current === group) publishHandlers(group);
        };

        if (property === "events") return {
          on(name: string, handler: Handler) {
            const listener: Group["listeners"][number] = { name, handler, removed: false }; group.listeners.push(listener);
            let unsubscribe: (() => void) | undefined;

            if (group.ready && current === group) { unsubscribe = pi.events.on(name, handler); group.stops.push(unsubscribe); }

            return () => { listener.removed = true; unsubscribe?.(); listener.unsubscribe?.(); };
          },
          emit(name: string, value: unknown) {
            if (!group.ready || current !== group) throw new Error("piop extension events may only be emitted after activation");

            return pi.events.emit(name, value);
          },
        };

        if (registrations.has(String(property))) return (...args: unknown[]) => {
          if (group.ready) throw new Error("piop extensions must register resources during initialization");
          const name = property === "registerTool" ? (args[0] as Tool).name : args[0] as string;
          const items = group.registrations.get(String(property)) ?? new Map();

          if (items.has(name)) throw new Error(`Duplicate piop extension registration: ${String(property)} ${name}`);
          items.set(name, args); group.registrations.set(String(property), items);
        };

        if (property === "getFlag" && !group.ready) return (name: string) => (group.registrations.get("registerFlag")?.get(name)?.[1] as { default?: unknown } | undefined)?.default;
        const value = Reflect.get(target, property);

        if (typeof value !== "function") return value;

        return (...args: unknown[]) => {
          if (!group.ready || current !== group) throw new Error(`piop extension API ${String(property)} is unavailable before activation or after deactivation`);

          return value.apply(target, args);
        };
      }
    });

    async function load(path: string, parent: string) {
      path = bundledPath(path, parent, baseDirectory);
      const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(parent, path);

      try {
        let entry = await realpath(absolute);

        if ((await stat(entry)).isDirectory()) entry = await directoryEntry(entry);

        if (visiting.includes(entry)) throw new Error(`Circular piop extension dependency: ${[...visiting, entry].join(" -> ")}`);

        if (loaded.has(entry)) return;
        visiting.push(entry);
        const module = await import(entry);

        if (typeof module.default !== "function") throw new Error("Expected a default piop extension factory");

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
    for (const [event, handlers] of group.handlers) {
      if (event === "session_start") continue;

      for (let index = dispatchedEvents.get(event) ?? 0; index < handlers.length; index++) {
        const subscribe = pi.on as unknown as (event: string, handler: Handler) => void;
        subscribe.call(pi, event, (...args: unknown[]) => current?.handlers.get(event)?.[index]?.(...args));
      }

      dispatchedEvents.set(event, Math.max(dispatchedEvents.get(event) ?? 0, handlers.length));
    }
  }

  function publishRegistration(method: string, name: string, args: unknown[]) {
    if (method === "registerCommand") {
      dispatchedCommands.add(name);
      pi.registerCommand(name, {
        ...args[1] as Command, handler: (...values: Parameters<Command["handler"]>) => {
          const command = current?.registrations.get(method)?.get(name)?.[1] as Command | undefined;

          if (!command) throw new Error(`piop extension command is inactive: ${name}`);

          return command.handler(...values);
        }
      });
    } else if (method === "registerTool") {
      managedTools.add(name);
      pi.registerTool({
        ...args[0] as Tool, execute: (...values: Parameters<Tool["execute"]>) => {
          const tool = current?.registrations.get(method)?.get(name)?.[0] as Tool | undefined;

          if (!tool) throw new Error(`piop extension tool is inactive: ${name}`);

          return tool.execute(...values);
        }
      });
    } else {
      const values = method === "registerShortcut" ? [args[0], { ...args[1] as object, handler: (...values: unknown[]) => (current?.registrations.get(method)?.get(name)?.[1] as { handler: Handler } | undefined)?.handler(...values) }] : args;
      Reflect.get(pi, method).apply(pi, values);
    }
  }

  async function start(group: Group, ctx: ExtensionContext) {
    for (const handler of group.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  }

  function hideInactiveTools(group: Group | undefined, activeGroup: Group | undefined) {
    const activeTools = new Set(tools(activeGroup));

    for (const [name, args] of group?.registrations.get("registerTool") ?? []) {
      if (activeTools.has(name)) continue;
      pi.registerTool({ ...args[0] as Tool, exposure: "hidden", execute: async () => { throw new Error(`piop extension tool is inactive: ${name}`); } });
    }
  }

  async function shutdown(group: Group | undefined, ctx: ExtensionContext) {
    const active = current;
    current = group;

    try {
      for (const handler of group?.handlers.get("session_shutdown") ?? []) {
        try { await handler({ type: "session_shutdown" }, ctx); }
        catch (error) { ctx.ui.notify(`piop extension cleanup failed: ${String(error)}`, "error"); }
      }
    } finally { current = active; }
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

      for (const [method, items] of group.registrations) for (const [name, args] of items) publishRegistration(method, name, args);
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

      for (const [name, args] of previous?.registrations.get("registerTool") ?? []) publishRegistration("registerTool", name, args);
      throw error;
    }
  }

  return { prepare, activate, tools, stop: () => stop(current) };
}
