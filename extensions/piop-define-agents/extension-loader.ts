import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const extensionPathsSchema = Type.Array(Type.String({ pattern: "\\S" }));

type Handler = (...args: unknown[]) => unknown;

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
  handlers: Map<string, Handler[]>;
  registrations: Map<Registration["method"], Map<string, Registration>>;
  listeners: Array<{ name: string; handler: Handler; removed?: boolean; unsubscribe?: () => void }>;
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

export function agentExtensions(pi: ExtensionAPI, baseDirectory: string) {
  let current: Group | undefined;
  const dispatchedEvents = new Map<string, number>();
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
    const group: Group = { key, handlers: new Map(), registrations: new Map(), listeners: [], stops: [], ready: false };
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
    for (const [event, handlers] of group.handlers) {
      if (event === "session_start") continue;

      for (let index = dispatchedEvents.get(event) ?? 0; index < handlers.length; index++) {
        const subscribe = pi.on as unknown as (event: string, handler: Handler) => void;
        subscribe.call(pi, event, (...args: unknown[]) => current?.handlers.get(event)?.[index]?.(...args));
      }

      dispatchedEvents.set(event, Math.max(dispatchedEvents.get(event) ?? 0, handlers.length));
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
    for (const handler of group.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
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
      for (const handler of group?.handlers.get("session_shutdown") ?? []) {
        try { await handler({ type: "session_shutdown" }, ctx); }
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
