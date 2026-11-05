import { createSignal } from "solid-js";
import { invoke } from "../lib/platform";
import { flushPlugins, waitForClientPlugins } from "./lifecycle";
import { loadPluginClients } from "./clientModules";
import type { AuxiliaryLook, PluginStatus } from "../../../protocol/plugins";

// True when the host runs this slash command only after the current response, never as a steering message.
// The commands in withPrompt are queued only when text follows them.
export function queuedCommand(text: string, queuedCommands: readonly string[], withPrompt: readonly string[] = []) {
  const [word] = text.trim().split(/\s/, 1);

  if (!word.startsWith("/")) return false;
  const name = word.slice(1);

  return queuedCommands.includes(name) || (withPrompt.includes(name) && /^\/\S+\s+\S/.test(text.trimStart()));
}

export type { PluginStatus };

const [statuses, setStatuses] = createSignal<Record<string, PluginStatus>>({});

const [errors, setErrors] = createSignal<Record<string, string | undefined>>({});

const requests = new Map<string, number>();

export const pluginStatus = (host: string) => statuses()[host];

export const pluginName = (host: string, id: string) => pluginStatus(host)?.plugins.find(plugin => plugin.id === id)?.name ?? id;

// How the side chats of a kind look. The kind of a plugin's side chats is the plugin's ID.
export function auxiliaryLook(kind: string): AuxiliaryLook {
  for (const status of Object.values(statuses())) {
    const look = status.plugins.find(plugin => plugin.id === kind)?.auxiliary;

    if (look) return look;
  }

  return { label: kind, letter: kind.slice(0, 1).toUpperCase(), color: "#8f8b82" };
}

export const pluginError = (host: string) => errors()[host] ?? statuses()[host]?.error;

export const setPluginError = (host: string, error?: string) => setErrors(previous => ({ ...previous, [host]: error }));

function nextRequest(host: string) {
  const request = (requests.get(host) ?? 0) + 1;
  requests.set(host, request);

  return request;
}

function acceptPluginStatus(host: string, status: PluginStatus, request: number) {
  if (requests.get(host) !== request) return;
  setStatuses(previous => ({ ...previous, [host]: status })); setPluginError(host);
  void loadPluginClients(host, status).then(failures => {
    if (failures.length && pluginStatus(host)?.revision === status.revision) setPluginError(host, `Plugins could not load: ${failures.join("\n")}`);
  });
}

export async function refreshPlugins(host: string) {
  const request = nextRequest(host);
  const status = await invoke("plugin_status", { hostId: host });
  acceptPluginStatus(host, status, request);

  return status;
}

export async function restartPlugins(host: string, enabled: string[], revision: string, closeTerminals = false) {
  const previous = await refreshPlugins(host);

  if (previous.revision !== revision) throw new Error("Plugin setup changed in another client. Reload the plugin setup before restarting.");
  await flushPlugins(host, enabled);
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
  const response = await invoke("restart_daemon", { hostId: host, enabled, revision, closeTerminals });

  if ("confirmationRequired" in response) return response;
  const { restartId } = response;

  if (host === "local") window.dispatchEvent(new Event("piop-daemon-restarting"));
  const result = await waitForRestart(host, restartId);
  const status = await refreshPlugins(host);

  return { status, result };
}

async function waitForRestart(host: string, restartId: string) {
  const deadline = Date.now() + 240000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await invoke("daemon_restart_status", { hostId: host, restartId }).catch((reason: unknown) => { lastError = reason; return undefined; });

    if (result?.phase === "failed") throw new Error(result.error ?? "Daemon restart failed");

    if (result?.phase === "complete" || result?.phase === "rolled_back") return result;
  }

  const detail = lastError === undefined ? "" : ` Last status error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  throw new Error(`Could not confirm the daemon restart. Reconnect and reload the plugin setup.${detail}`);
}
