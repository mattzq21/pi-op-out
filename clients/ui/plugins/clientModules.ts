import * as solid from "solid-js";
import * as solidWeb from "solid-js/web";
import * as solidStore from "solid-js/store";
import * as zod from "zod";
import { z } from "zod";
import { SHARED_MODULES_KEY, type PluginStatus, type PluginSummary, type SHARED_MODULES } from "../../../protocol/plugins";
import { invoke } from "../lib/platform";
import * as api from "./api";
import { registerPluginReadiness } from "./lifecycle";
import type { PluginModule } from "./types";

// The client parts of the plugins, from the client.mjs of each enabled plugin of each host. A client.mjs gets these
// modules from the app, so that it uses the app's Solid and contexts.
(globalThis as Record<symbol, unknown>)[Symbol.for(SHARED_MODULES_KEY)] = {
  "solid-js": solid, "solid-js/web": solidWeb, "solid-js/store": solidStore, zod, "piop/plugin": api,
} satisfies Record<(typeof SHARED_MODULES)[number], unknown>;

const functionSchema = z.custom<(...args: never[]) => unknown>(value => typeof value === "function", "Must be a function");

const moduleSchema = z.object({
  createPlugin: functionSchema.optional(),
  settings: z.object({ label: z.string().min(1), description: z.string(), icon: functionSchema, component: functionSchema }).optional(),
  messages: z.record(z.string(), functionSchema).optional(),
});

interface HostClients { revision: string; done: Promise<string[]>; failed: boolean }

const loads = new Map<string, HostClients>();

const [loaded, setLoaded] = solid.createSignal<Record<string, Record<string, PluginModule>>>({});

async function loadModule(host: string, plugin: PluginSummary): Promise<PluginModule> {
  const { source } = await invoke("plugin_client", { hostId: host, id: plugin.id });
  const namespace: unknown = await import(/* @vite-ignore */ "data:text/javascript;charset=utf-8," + encodeURIComponent(source));
  const parsed = moduleSchema.safeParse(namespace);

  if (!parsed.success) throw new Error("Invalid client.mjs: " + z.prettifyError(parsed.error));

  return parsed.data as PluginModule;
}

// Loads the client parts of the enabled plugins of a host, once for each plugin setup of the host, and again after a
// failure. Gives the plugins that could not load, with their errors.
export function loadPluginClients(host: string, status: PluginStatus): Promise<string[]> {
  const current = loads.get(host);

  if (current?.revision === status.revision && !current.failed) return current.done;
  const wanted = status.plugins.filter(plugin => plugin.client && status.enabled.includes(plugin.id));
  const failures: string[] = [];
  const done = Promise.all(wanted.map(plugin => loadModule(host, plugin).then(
    module => [[plugin.id, module] as const],
    (reason: unknown) => { failures.push(`${plugin.name}: ${reason instanceof Error ? reason.message : String(reason)}`); return []; },
  ))).then(results => {
    const load = loads.get(host);

    if (load?.done === done) { load.failed = failures.length > 0; setLoaded(previous => ({ ...previous, [host]: Object.fromEntries(results.flat()) })); }

    return failures;
  });
  loads.set(host, { revision: status.revision, done, failed: false });

  return done;
}

registerPluginReadiness(async host => {
  const failures = await (loads.get(host)?.done ?? Promise.resolve([]));

  if (failures.length) throw new Error(failures.join("\n"));
});

export const pluginModule = (host: string, id: string): PluginModule | undefined => loaded()[host]?.[id];

// The client part of a plugin, after the current loads of its host end.
export async function pluginClient(host: string, id: string) {
  let pending: Promise<string[]> | undefined;

  do { pending = loads.get(host)?.done; await pending; } while (pending !== loads.get(host)?.done);

  return solid.untrack(() => pluginModule(host, id));
}

export const pluginSettingsPages = (host: string) => Object.entries(loaded()[host] ?? {}).flatMap(([id, module]) => module.settings ? [{ id, ...module.settings }] : []);

export function pluginMessageRenderer(host: string, customType?: string) {
  if (customType === undefined) return undefined;

  for (const module of Object.values(loaded()[host] ?? {})) if (module.messages && Object.hasOwn(module.messages, customType)) return module.messages[customType];

  return undefined;
}
