import { createEffect, createMemo, createRoot, createSignal, For, getOwner, onCleanup, Show, untrack, type Accessor } from "solid-js";
import { PanelRight } from "lucide-solid";
import { z } from "zod";
import { IconButton } from "../components/IconButton";
import { listen } from "../lib/platform";
import { pluginError, pluginStatus, plugins, refreshPlugins, setPluginError } from ".";
import type { PluginConversation, PluginInstance } from "./types";
import { Sidepane } from "./Sidepane";
import "./workspace.css";

interface RunningPlugin { id: string; name: string; instance: PluginInstance; dispose: () => void }

export function createPluginWorkspace(source: Accessor<PluginConversation>, visible: Accessor<boolean>, onOpen: () => void) {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal("chatgpt");
  const [running, setRunning] = createSignal<RunningPlugin[]>([]);
  const [loadError, setLoadError] = createSignal<string>();
  const owner = getOwner();
  let generation = 0;
  let disposed = false;
  const host = createMemo(() => source().hostId);
  const runtimeHost = (scope: string) => scope === "client" ? "local" : host();
  const hosts = createMemo(() => [...new Set(plugins.map(plugin => runtimeHost(plugin.scope)))]);
  const conversationReady = createMemo(() => Boolean(source().sessionId) && (source().messageCount ?? 0) > 0);
  const enabledPlugins = createMemo(() => plugins.filter(plugin => (plugin.scope === "client" || conversationReady()) && pluginStatus(runtimeHost(plugin.scope))?.enabled.includes(plugin.id)));
  const error = () => loadError() ?? hosts().map(pluginError).filter(Boolean).join("\n");
  const activate = (id: string) => { onOpen(); setActive(id); setOpen(true); };

  createEffect(() => {
    for (const target of hosts()) void refreshPlugins(target).catch(reason => setPluginError(target, String(reason)));
  });

  const listener = listen("pi://plugins-changed", ({ payload }) => {
    const target = payload.hostId ?? "local";
    void refreshPlugins(target).catch(reason => setPluginError(target, String(reason)));
  }, z.object({ hostId: z.string().optional() }));

  const reconnected = listen("pi://event", ({ payload }) => {
    if (payload.type !== "connection_restored") return;

    for (const target of hosts()) void refreshPlugins(target).catch(reason => setPluginError(target, String(reason)));
  }, z.object({ type: z.string().optional() }).passthrough());

  onCleanup(() => { void reconnected.then(stop => stop()); });

  createEffect(() => {
    const enabled = enabledPlugins();
    const current = ++generation;
    void Promise.all(enabled.map(async definition => ({ definition, module: await definition.load() }))).then(loaded => {
      if (disposed || current !== generation) return;
      const previous = untrack(running);

      const next = loaded.map(({ definition, module }) => previous.find(item => item.id === definition.id) ?? createRoot(dispose => ({
        id: definition.id, name: definition.name, dispose,
        instance: module.createPlugin({ source, visible: () => open() && visible() && active() === definition.id, activate: () => activate(definition.id) }),
      }), owner));

      setRunning(next);

      for (const item of previous) if (!next.includes(item)) item.dispose();

      if (!next.some(item => item.id === untrack(active))) setActive(next[0]?.id ?? "");

      if (!next.length) setOpen(false);
      setLoadError(undefined);
    }).catch(reason => { if (current === generation) setLoadError(`Plugins could not load: ${String(reason)}`); });
  });
  createEffect(() => { if (open()) running().find(item => item.id === active())?.instance.show?.(); });
  onCleanup(() => { disposed = true; generation++;

  for (const item of running()) item.dispose(); void listener.then(stop => stop()); });

  const close = () => setOpen(false);

  const changeTab = (event: KeyboardEvent) => {
    const items = running();
    const index = items.findIndex(item => item.id === active());

    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : -1;

    const item = items[next];

    if (!item) return;
    event.preventDefault(); setActive(item.id); document.getElementById(`plugin-tab-${item.id}`)?.focus();
  };

  const button = () => <Show when={running().length || error()}><IconButton class="open-plugins-button" label="Open sidepane" aria-controls="plugin-sidepane" aria-expanded={open()} onClick={() => { if (open()) close(); else { onOpen(); setOpen(true); } }}><PanelRight size={19} /></IconButton></Show>;

  const panel = () => <Sidepane open={open() && visible()}>
    <header class="plugin-pane-header"><div role="tablist" aria-label="Sidepane plugins" onKeyDown={changeTab}><For each={running()}>{item => <button id={`plugin-tab-${item.id}`} role="tab" aria-controls={`plugin-panel-${item.id}`} aria-selected={active() === item.id} tabIndex={active() === item.id ? 0 : -1} onClick={() => setActive(item.id)}>{item.name}</button>}</For></div>
    </header>
    <Show when={error()}><p class="plugin-error" role="alert">{error()}</p></Show>
    <For each={running()}>{item => <div class="plugin-panel" id={`plugin-panel-${item.id}`} role="tabpanel" aria-labelledby={`plugin-tab-${item.id}`} hidden={active() !== item.id}>{item.instance.panel()}</div>}</For>
  </Sidepane>;

  return { open, close, button, panel, transcripts: () => running().flatMap(item => item.instance.transcript ? [item.instance.transcript] : []) };
}
