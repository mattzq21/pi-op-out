import { createSignal } from "solid-js";
import { z } from "zod";
import { invoke } from "../lib/platform";
import type { PluginModule } from "./types";
import { flushPlugins } from "./lifecycle";

export const plugins = [
  { id: "chatgpt", scope: "client", name: "ChatGPT", description: "Client-owned ChatGPT chats with context from any agent host.", load: (): Promise<PluginModule> => import("./chatgpt/plugin") },
  { id: "markdown", scope: "conversation", name: "Markdown notes", description: "Shared conversation notes, with one client editing at a time.", load: (): Promise<PluginModule> => import("./markdown/plugin") },
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
  if (requests.get(host) === request) { setStatuses(previous => ({ ...previous, [host]: status })); setPluginError(host); }
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
  const { restartId } = await invoke("restart_daemon", { hostId: host, enabled, revision }, z.object({ restartId: z.string() }));

  if (host === "local") window.dispatchEvent(new Event("piop-daemon-restarting"));
  const result = await waitForRestart(host, restartId);
  const status = await refreshPlugins(host);
  const error = result.error ?? status.error;
  setPluginError(host, error ?? undefined);

  return { ...status, error };
}

const restartStatusSchema = z.object({ phase: z.string(), error: z.string().nullable() });

async function waitForRestart(host: string, restartId: string) {
  const deadline = Date.now() + 240000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await invoke("daemon_restart_status", { hostId: host, restartId }, restartStatusSchema).catch(() => undefined);

    if (result?.phase === "failed") throw new Error(result.error ?? "Daemon restart failed");

    if (result?.phase === "complete" || result?.phase === "rolled_back") return result;
  }

  throw new Error("Could not confirm the daemon restart. Reconnect and reload the plugin setup.");
}
