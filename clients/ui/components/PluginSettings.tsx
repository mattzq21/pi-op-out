import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ArrowDown, ArrowUp, Check } from "lucide-solid";
import { pluginError, plugins, refreshPlugins, restartPlugins, type PluginStatus } from "../plugins";
import { Toggle } from "./Toggle";

export function PluginSettings(props: { hostId: string; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = createSignal<PluginStatus>();
  const [enabled, setEnabled] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [message, setMessage] = createSignal<string>();
  const [terminalConfirmation, setTerminalConfirmation] = createSignal<number>();
  const [restarted, setRestarted] = createSignal(false);
  let successTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const reload = async () => {
    setBusy(true); setError(undefined);

    try { const current = await refreshPlugins(props.hostId);

    if (!disposed) { setStatus(current); setEnabled(current.configured); } }
    catch (reason) { if (!disposed) setError((reason instanceof Error ? reason.message : String(reason))); }
    finally { if (!disposed) setBusy(false); }
  };

  onMount(() => void reload());
  createEffect(() => props.onBusyChange?.(busy()));
  onCleanup(() => { disposed = true; clearTimeout(successTimer); props.onBusyChange?.(false); });
  const change = (id: string, checked: boolean) => { setMessage(undefined); setEnabled(previous => checked ? [...previous, id] : previous.filter(value => value !== id)); };

  const orderedPlugins = () => [...enabled().flatMap(id => plugins.filter(plugin => plugin.id === id)), ...plugins.filter(plugin => !enabled().includes(plugin.id))];

  const move = (id: string, offset: number) => {
    setEnabled(previous => {
      const index = previous.indexOf(id);
      const target = index + offset;

      if (index < 0 || target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];

      return next;
    });
  };

  const restart = async (closeTerminals = false) => {
    const current = status();

    if (!current || busy()) return;
    clearTimeout(successTimer); setRestarted(false);
    setBusy(true); setError(undefined); setMessage("Restarting the daemon and reconnecting…");

    try {
      const result = await restartPlugins(props.hostId, enabled(), current.revision, closeTerminals);

      if (disposed) return;

      if ("confirmationRequired" in result) {
        setMessage(undefined); setTerminalConfirmation(result.terminalCount);

        return;
      }

      setStatus(result); setEnabled(result.configured);
      setMessage(undefined);

      if (!result.error) {
        setRestarted(true);
        successTimer = setTimeout(() => setRestarted(false), 10000);
      }
    } catch (reason) {
      if (!disposed) { setError((reason instanceof Error ? reason.message : String(reason))); setMessage(undefined); }
    } finally { if (!disposed) setBusy(false); }
  };

  return <div class="settings-section">
    <div class="section-title">
      <div><h2>Plugins</h2><p>Loading order for this daemon and its clients.</p></div>
      <div class="plugin-restart-actions">
        <Show when={restarted()}><span class="plugin-restart-success" role="status" aria-label="Daemon restarted"><Check size={18} aria-hidden="true" /></span></Show>
        <button class="secondary-button" type="button" disabled={busy() || !status()} onClick={() => void restart()}>{busy() ? "Please wait…" : "Restart daemon"}</button>
      </div>
    </div>
    <Show when={error() || status()?.error || pluginError(props.hostId)}><p role="alert">{error() || status()?.error || pluginError(props.hostId)}</p></Show>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <div class="config-list"><For each={orderedPlugins()}>{plugin => <div class="config-row plugin-settings-row">
      <Toggle label={`Enable ${plugin.name} plugin`} checked={enabled().includes(plugin.id)} disabled={busy() || !status()} onChange={checked => change(plugin.id, checked)} />
      <span><strong>{plugin.name}</strong></span>
      <div class="plugin-order-actions">
        <button type="button" class="icon-button" aria-label={`Load ${plugin.name} earlier`} disabled={busy() || !status() || enabled().indexOf(plugin.id) <= 0} onClick={() => move(plugin.id, -1)}><ArrowUp size={16} /></button>
        <button type="button" class="icon-button" aria-label={`Load ${plugin.name} later`} disabled={busy() || !status() || !enabled().includes(plugin.id) || enabled().indexOf(plugin.id) === enabled().length - 1} onClick={() => move(plugin.id, 1)}><ArrowDown size={16} /></button>
      </div>
    </div>}</For></div>
    <Show when={error()}><button type="button" disabled={busy()} onClick={() => void reload()}>Reload plugin setup</button></Show>
    <Show when={terminalConfirmation()}>{count => <RestartTerminalsDialog count={count()} onCancel={() => setTerminalConfirmation(undefined)} onConfirm={() => {
      setTerminalConfirmation(undefined); void restart(true);
    }} />}</Show>
  </div>;
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
