import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { pluginError, plugins, refreshPlugins, restartPlugins, type PluginStatus } from "../plugins";
import { Toggle } from "./Toggle";

export function PluginSettings(props: { hostId: string; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = createSignal<PluginStatus>();
  const [enabled, setEnabled] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [message, setMessage] = createSignal<string>();
  let disposed = false;

  const reload = async () => {
    setBusy(true); setError(undefined);

    try { const current = await refreshPlugins(props.hostId);

    if (!disposed) { setStatus(current); setEnabled(current.enabled); } }
    catch (reason) { if (!disposed) setError(String(reason)); }
    finally { if (!disposed) setBusy(false); }
  };

  onMount(() => void reload());
  createEffect(() => props.onBusyChange?.(busy()));
  onCleanup(() => { disposed = true; props.onBusyChange?.(false); });
  const change = (id: string, checked: boolean) => { setMessage(undefined); setEnabled(previous => checked ? [...previous, id] : previous.filter(value => value !== id)); };

  const restart = async () => {
    const current = status();

    if (!current || busy()) return;
    setBusy(true); setError(undefined); setMessage("Restarting… Any active ChatGPT response will finish first.");

    try {
      const result = await restartPlugins(props.hostId, enabled(), current.revision);

      if (disposed) return;
      setStatus(result); setEnabled(result.enabled);
      setMessage(result.error ? undefined : "Restarted. Your plugins are ready.");
    } catch (reason) {
      if (!disposed) { setError(String(reason)); setMessage(undefined); }
    } finally { if (!disposed) setBusy(false); }
  };

  return <>
    <p>Choose your plugins, then restart to apply changes. If a plugin cannot load, the previous setup stays active.</p>
    <Show when={error() || status()?.error || pluginError(props.hostId)}><p role="alert">{error() || status()?.error || pluginError(props.hostId)}</p></Show>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <div class="config-list"><For each={plugins}>{plugin => <div class="config-row">
      <span><strong>{plugin.name}</strong><small>{plugin.description}</small><small>Bundled · {status()?.enabled.includes(plugin.id) ? "Running" : "Inactive"}</small></span>
      <Toggle label={`Enable ${plugin.name} plugin`} checked={enabled().includes(plugin.id)} disabled={busy() || !status()} onChange={checked => change(plugin.id, checked)} />
    </div>}</For></div>
    <button type="button" disabled={busy() || !status()} onClick={() => void restart()}>{busy() ? "Please wait…" : "Restart daemon"}</button>
    <Show when={error()}><button type="button" disabled={busy()} onClick={() => void reload()}>Reload plugin setup</button></Show>
  </>;
}
