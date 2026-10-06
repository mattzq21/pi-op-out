import { createSignal } from "solid-js";
import { z } from "zod";
import { invoke } from "../lib/platform";
import type { PluginModule } from "./types";
import { flushPlugins } from "./lifecycle";

export const plugins = [
  { id: "chatgpt", name: "ChatGPT", description: "ChatGPT chats with agent conversation context and selected text.", load: (): Promise<PluginModule> => import("./chatgpt/plugin") },
  { id: "markdown", name: "Markdown notes", description: "Automatically saved notes for each conversation, with Markdown preview.", load: (): Promise<PluginModule> => import("./markdown/plugin") },
];

export const pluginStatusSchema = z.object({ enabled: z.array(z.string()), revision: z.string(), error: z.string().nullable() });

export type PluginStatus = z.infer<typeof pluginStatusSchema>;

const [statuses, setStatuses] = createSignal<Record<string, PluginStatus>>({});

const [errors, setErrors] = createSignal<Record<string, string | undefined>>({});

const requests = new Map<string, number>();

export const pluginStatus = (host: string) => statuses()[host];

export const pluginError = (host: string) => errors()[host] ?? statuses()[host]?.error;

export const setPluginError = (host: string, error?: string) => setErrors(previous => ({ ...previous, [host]: error }));

function nextRequest(host: string) {
  const request = (requests.get(host) ?? 0) + 1;
  requests.set(host, request);

  return request;
}

function acceptPluginStatus(host: string, status: PluginStatus, request: number) {
  if (requests.get(host) === request) setStatuses(previous => ({ ...previous, [host]: status }));
}

export async function refreshPlugins(host: string) {
  const request = nextRequest(host);
  const status = await invoke("plugin_status", { hostId: host }, pluginStatusSchema);
  acceptPluginStatus(host, status, request);

  return status;
}

export async function restartPlugins(host: string, enabled: string[], revision: string) {
  await flushPlugins(host);
  await Promise.all(plugins.flatMap(plugin => enabled.includes(plugin.id) ? [plugin.load()] : []));
  const request = nextRequest(host);
  const status = await invoke("restart_daemon", { hostId: host, enabled, revision }, pluginStatusSchema);
  acceptPluginStatus(host, status, request);
  setPluginError(host);

  return status;
}
