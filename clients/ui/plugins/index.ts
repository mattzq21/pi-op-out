import { createSignal } from "solid-js";
import { ClipboardCheck, Globe } from "lucide-solid";
import { z } from "zod";
import { invoke } from "../lib/platform";
import type { PluginDefinition } from "./types";
import { flushPlugins, waitForClientPlugins } from "./lifecycle";

export const plugins: PluginDefinition[] = [
  { id: "cost", scope: "host", name: "Cost limit", description: "Per-conversation API cost limit, set with /cost.", load: () => import("./cost/plugin") },
  { id: "review", scope: "host", name: "Review", description: "Code reviews in a split pane, started with /review.", load: () => import("./review/plugin"),
    settings: { section: "review", label: "Review", description: "Choose the agent that runs /review.", icon: ClipboardCheck, load: () => import("./review/ReviewSettings").then(module => ({ default: module.ReviewSettings })) },
    queuedCommands: ["review"],
    messages: { "piop-review-link": () => import("./review/ReviewLink").then(module => ({ default: module.ReviewLink })) } },
  { id: "web-search", scope: "host", name: "Web search", description: "The web_search tool for agents, through the host's OpenAI ChatGPT sign-in.",
    settings: { section: "web-search", label: "Web search", description: "Choose the OpenAI model that runs web searches.", icon: Globe, load: () => import("./web-search/WebSearchSettings").then(module => ({ default: module.WebSearchSettings })) } },
  { id: "btw", scope: "host", name: "Side chats", description: "Side chats started with /btw." },
];

const coreQueuedCommands = ["compact"];

export function queuedCommand(text: string) {
  const [word] = text.trim().split(/\s/, 1);

  return word.startsWith("/") && (coreQueuedCommands.includes(word.slice(1)) || plugins.some(plugin => plugin.queuedCommands?.includes(word.slice(1))));
}

export const pluginStatusSchema = z.object({ enabled: z.array(z.string()), configured: z.array(z.string()), revision: z.string(), error: z.string().nullable() });

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

export async function restartPlugins(host: string, enabled: string[], revision: string, closeTerminals = false) {
  const previous = await refreshPlugins(host);

  if (previous.revision !== revision) throw new Error("Plugin setup changed in another client. Reload the plugin setup before restarting.");
  await flushPlugins(host, enabled);

  for (const id of enabled) {
    const plugin = plugins.find(plugin => plugin.id === id);

    if (plugin?.load) await plugin.load();
  }

  const response = await restartDaemon(host, enabled, revision, closeTerminals);

  if ("confirmationRequired" in response) return response;
  const { status, result } = response;

  try { await waitForClientPlugins(host); }
  catch (reason) {
    if (result.phase !== "complete") throw new Error(`Client plugins could not load after daemon recovery: ${(reason instanceof Error ? reason.message : String(reason))}`);

    return restorePlugins(host, previous.configured, status.revision, (reason instanceof Error ? reason.message : String(reason)));
  }

  const error = result.error ?? status.error;
  setPluginError(host, error ?? undefined);

  return { ...status, error };
}

async function restorePlugins(host: string, enabled: string[], revision: string, reason: string) {
  try {
    await flushPlugins(host, enabled);
    const restored = await restartDaemon(host, enabled, revision, false);

    if ("confirmationRequired" in restored) throw new Error("Close running terminals before restoring the previous plugin setup.");

    if (restored.result.phase !== "complete" || restored.status.error) throw new Error(restored.result.error ?? restored.status.error ?? "The previous plugin setup could not start.");
    await waitForClientPlugins(host);
    const error = `Client plugins could not load: ${reason}. Restored the previous setup.`;
    setPluginError(host, error);

    return { ...restored.status, error };
  } catch (recoveryError) {
    const error = `Client plugins could not load: ${reason}. Could not restore the previous setup: ${(recoveryError instanceof Error ? recoveryError.message : String(recoveryError))}`;
    setPluginError(host, error);
    throw new Error(error);
  }
}

async function restartDaemon(host: string, enabled: string[], revision: string, closeTerminals: boolean) {
  const response = await invoke("restart_daemon", { hostId: host, enabled, revision, closeTerminals }, z.union([
    z.object({ restartId: z.string() }),
    z.object({ confirmationRequired: z.literal("terminals"), terminalCount: z.number() }),
  ]));

  if ("confirmationRequired" in response) return response;
  const { restartId } = response;

  if (host === "local") window.dispatchEvent(new Event("piop-daemon-restarting"));
  const result = await waitForRestart(host, restartId);
  const status = await refreshPlugins(host);

  return { status, result };
}

const restartStatusSchema = z.object({ phase: z.string(), error: z.string().nullable() });

async function waitForRestart(host: string, restartId: string) {
  const deadline = Date.now() + 240000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await invoke("daemon_restart_status", { hostId: host, restartId }, restartStatusSchema).catch((reason: unknown) => { lastError = reason; return undefined; });

    if (result?.phase === "failed") throw new Error(result.error ?? "Daemon restart failed");

    if (result?.phase === "complete" || result?.phase === "rolled_back") return result;
  }

  const detail = lastError === undefined ? "" : ` Last status error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  throw new Error(`Could not confirm the daemon restart. Reconnect and reload the plugin setup.${detail}`);
}
