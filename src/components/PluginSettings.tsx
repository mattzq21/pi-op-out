import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { pluginError, plugins, refreshPlugins, restartPlugins, type PluginStatus } from "../plugins";
import { Toggle } from "./Toggle";

export function PluginSettings(props: { hostId: string; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = createSignal<PluginStatus>();
  const [enabled, setEnabled] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [message, setMessage] = createSignal<string>();
  const [terminalConfirmation, setTerminalConfirmation] = createSignal<number>();
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

  const restart = async (closeTerminals = false) => {
    const current = status();

    if (!current || busy()) return;
    setBusy(true); setError(undefined); setMessage("Restarting the daemon and reconnecting…");

    try {
      const result = await restartPlugins(props.hostId, enabled(), current.revision, closeTerminals);

      if (disposed) return;

      if ("confirmationRequired" in result) {
        setMessage(undefined); setTerminalConfirmation(result.terminalCount);

        return;
      }

      setStatus(result); setEnabled(result.enabled);
      setMessage(result.error ? undefined : "Restarted. Your plugins are ready.");
    } catch (reason) {
      if (!disposed) { setError(String(reason)); setMessage(undefined); }
    } finally { if (!disposed) setBusy(false); }
  };

  return <>
    <Show when={error() || status()?.error || pluginError(props.hostId)}><p role="alert">{error() || status()?.error || pluginError(props.hostId)}</p></Show>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <div class="config-list"><For each={plugins}>{plugin => <div class="config-row plugin-settings-row">
      <span><strong>{plugin.name}</strong></span>
      <Toggle label={`Enable ${plugin.name} plugin`} checked={enabled().includes(plugin.id)} disabled={busy() || !status()} onChange={checked => change(plugin.id, checked)} />
    </div>}</For></div>
    <button type="button" disabled={busy() || !status()} onClick={() => void restart()}>{busy() ? "Please wait…" : "Restart daemon"}</button>
    <Show when={error()}><button type="button" disabled={busy()} onClick={() => void reload()}>Reload plugin setup</button></Show>
    <Show when={terminalConfirmation()}>{count => <RestartTerminalsDialog count={count()} onCancel={() => setTerminalConfirmation(undefined)} onConfirm={() => {
      setTerminalConfirmation(undefined); void restart(true);
    }} />}</Show>
  </>;
}

function RestartTerminalsDialog(props: { count: number; onCancel: () => void; onConfirm: () => void }) {
  let dialog: HTMLDialogElement | undefined;
  onMount(() => {
    const returnFocus = document.activeElement;
    dialog?.showModal();
    onCleanup(() => {
      dialog?.close();

      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    });
  });

  return <dialog ref={dialog} class="extension-dialog" aria-label="Close terminals and restart?" onCancel={event => { event.preventDefault(); props.onCancel(); }}>
    <h2>Close terminals and restart?</h2>
    <p>Restarting this daemon will close {props.count} running {props.count === 1 ? "terminal" : "terminals"}, including any commands running in them.</p>
    <div class="dialog-actions"><button autofocus onClick={props.onCancel}>Cancel</button><button class="primary-button" onClick={props.onConfirm}>Close terminals and restart</button></div>
  </dialog>;
}
