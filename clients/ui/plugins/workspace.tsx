import { createEffect, createMemo, createRoot, createSignal, For, getOwner, onCleanup, Show, untrack, type Accessor } from "solid-js";
import { PanelRight, X } from "lucide-solid";
import { z } from "zod";
import { IconButton } from "../components/IconButton";
import { listen } from "../lib/platform";
import { pluginError, pluginStatus, plugins, refreshPlugins, setPluginError } from ".";
import type { PluginConversation, PluginInstance } from "./types";
import { Sidepane } from "./Sidepane";
import { PluginTabPicker } from "./PluginTabPicker";
import { flushPlugins, registerPluginReadiness } from "./lifecycle";
import "./workspace.css";

interface RunningPlugin { id: string; name: string; host: string; revision: string | undefined; instance: PluginInstance; dispose: () => void }

export function createPluginWorkspace(source: Accessor<PluginConversation>, visible: Accessor<boolean>, onOpen: () => void) {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal("");
  const [selectedTabs, setSelectedTabs] = createSignal<string[]>([]);
  const [running, setRunning] = createSignal<RunningPlugin[]>([]);
  const panels = createMemo(() => running().filter(item => item.instance.panel));
  const tabs = createMemo(() => panels().filter(item => selectedTabs().includes(item.id)));
  const [loadError, setLoadError] = createSignal<string>();
  const [reloading, setReloading] = createSignal(false);
  const owner = getOwner();
  let generation = 0;
  let disposed = false;
  let loading: Promise<void> = Promise.resolve();
  let loadingFailures: { host: string; message: string }[] = [];
  const host = createMemo(() => source().hostId);
  const runtimeHost = (scope: string) => scope === "client" ? "local" : host();
  const hosts = createMemo(() => [...new Set(plugins.map(plugin => runtimeHost(plugin.scope)))]);
  const conversationReady = createMemo(() => Boolean(source().sessionId) && (source().messageCount ?? 0) > 0);

  const enabledPlugins = createMemo(() => {
    const order = [...new Set([host(), ...hosts()].flatMap(target => pluginStatus(target)?.enabled ?? []))];

    return order.flatMap(id => plugins.filter(plugin => plugin.id === id && (plugin.scope !== "conversation" || conversationReady()) && pluginStatus(runtimeHost(plugin.scope))?.enabled.includes(plugin.id)));
  });

  const configuration = createMemo(() => JSON.stringify([
    host(), hosts().map(target => [target, pluginStatus(target)?.revision]), enabledPlugins().map(plugin => plugin.id),
  ]));

  const error = () => loadError() ?? hosts().map(pluginError).filter(Boolean).join("\n");

  const activate = (id: string) => {
    setSelectedTabs(previous => previous.includes(id) ? previous : [...previous, id]);
    onOpen(); setActive(id); setOpen(true);
  };

  createEffect(() => {
    for (const target of hosts()) void refreshPlugins(target).catch(reason => setPluginError(target, (reason instanceof Error ? reason.message : String(reason))));
  });

  const listener = listen("pi://plugins-changed", ({ payload }) => {
    const target = payload.hostId ?? "local";
    void refreshPlugins(target).catch(reason => setPluginError(target, (reason instanceof Error ? reason.message : String(reason))));
  }, z.object({ hostId: z.string().optional() }));

  const reconnected = listen("pi://event", ({ payload }) => {
    if (payload.type !== "connection_restored") return;

    for (const target of hosts()) void refreshPlugins(target).catch(reason => setPluginError(target, (reason instanceof Error ? reason.message : String(reason))));
  }, z.object({ type: z.string().optional() }).passthrough());

  onCleanup(() => { void reconnected.then(stop => stop()); });

  onCleanup(registerPluginReadiness(async target => {
    let pending: Promise<void>;

    do { pending = loading; await pending; } while (pending !== loading);

    const failures = loadingFailures.filter(failure => failure.host === target);

    if (!disposed && failures.length) throw new Error(failures.map(failure => failure.message).join("\n"));
  }));

  createEffect(() => {
    configuration();
    const enabled = untrack(() => enabledPlugins().map(definition => {
      const host = runtimeHost(definition.scope);

      return { definition, host, revision: pluginStatus(host)?.revision };
    }));
    const configurationHost = untrack(host);
    const current = ++generation;
    const previous = untrack(running);
    const targets = [...new Set([...untrack(hosts), ...previous.map(item => item.host)])];
    setReloading(true);
    const stale = () => disposed || current !== generation;

    loading = (async () => {
      await untrack(() => Promise.all(targets.map(target => flushPlugins(target, pluginStatus(target)?.enabled))));

      if (stale()) return;
      const retained = previous.filter(item => enabled.some(target => target.definition.id === item.id && target.host === item.host && (target.definition.retainOnHostRestart || target.revision === item.revision)));
      setRunning(retained);

      for (const item of previous) if (!retained.includes(item)) item.dispose();
      const next = [...retained];
      const failures: { host: string; message: string }[] = [];

      for (const { definition, host, revision } of enabled) {
        if (stale()) return;
        if (retained.some(item => item.id === definition.id)) continue;

        try {
          const module = await definition.load();

          if (stale()) return;
          next.push(createRoot(dispose => {
            try {
              return { id: definition.id, name: definition.name, host, revision, dispose,
                instance: module.createPlugin({ source, visible: () => open() && visible() && active() === definition.id, activate: () => activate(definition.id) }) };
            } catch (reason) { dispose(); throw reason; }
          }, owner));
          setRunning([...next]);
        } catch (reason) {
          const affected = new Set([configurationHost, host]);
          failures.push(...[...affected].map(target => ({ host: target, message: `${definition.name}: ${(reason instanceof Error ? reason.message : String(reason))}` })));
        }
      }

      if (stale()) return;
      loadingFailures = failures;
      setRunning(enabled.flatMap(({ definition }) => next.filter(item => item.id === definition.id)));

      if (!next.some(item => item.instance.panel)) setOpen(false);
      setLoadError(failures.length ? `Plugins could not load: ${[...new Set(failures.map(failure => failure.message))].join("\n")}` : undefined);
    })().catch(reason => { if (current === generation) {
      loadingFailures = hosts().map(target => ({ host: target, message: reason instanceof Error ? reason.message : String(reason) }));
      setLoadError(`Plugins could not load: ${(reason instanceof Error ? reason.message : String(reason))}`);
    } }).finally(() => { if (!stale()) setReloading(false); });
  });
  createEffect(() => { if (!reloading() && !tabs().some(item => item.id === active())) setActive(tabs()[0]?.id ?? ""); });
  createEffect(() => { if (!reloading() && open()) running().find(item => item.id === active())?.instance.show?.(); });
  onCleanup(() => { disposed = true; generation++;

  for (const item of running()) item.dispose(); void listener.then(stop => stop()); });

  const close = () => setOpen(false);

  const removeTab = (id: string) => {
    setSelectedTabs(previous => previous.filter(tab => tab !== id));
    queueMicrotask(() => {
      const target = document.getElementById(`plugin-tab-${active()}`) ?? document.querySelector<HTMLElement>(".plugin-tab-picker summary");
      target?.focus();
    });
  };

  const changeTab = (event: KeyboardEvent) => {
    const items = tabs();
    const index = items.findIndex(item => item.id === active());

    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : -1;

    const item = items[next];

    if (!item) return;
    event.preventDefault(); setActive(item.id); document.getElementById(`plugin-tab-${item.id}`)?.focus();
  };

  const button = () => <Show when={panels().length || error()}><IconButton class="open-plugins-button" label="Open sidepane" aria-controls="plugin-sidepane" aria-expanded={open()} onClick={() => { if (open()) close(); else { onOpen(); setOpen(true); } }}><PanelRight size={19} /></IconButton></Show>;

  const panel = () => <Sidepane open={open() && visible()}>
    <header class="plugin-pane-header">
      <PluginTabPicker items={panels()} onSelect={activate} />
      <div role="tablist" aria-label="Sidepane plugins" onKeyDown={changeTab}><For each={tabs()}>{item => <div class="plugin-tab" role="presentation">
        <button id={`plugin-tab-${item.id}`} role="tab" aria-controls={`plugin-panel-${item.id}`} aria-selected={active() === item.id} tabIndex={active() === item.id ? 0 : -1} onClick={() => setActive(item.id)}>{item.name}</button>
        <button class="plugin-tab-remove" type="button" aria-label={`Remove ${item.name} tab`} tabIndex={active() === item.id ? 0 : -1} onClick={() => removeTab(item.id)}><X size={13} /></button>
      </div>}</For></div>
    </header>
    <Show when={error()}><p class="plugin-error" role="alert">{error()}</p></Show>
    <For each={tabs()}>{item => <div class="plugin-panel" id={`plugin-panel-${item.id}`} role="tabpanel" aria-labelledby={`plugin-tab-${item.id}`} hidden={active() !== item.id}>{item.instance.panel?.()}</div>}</For>
  </Sidepane>;

  return { open, close, button, panel, composers: () => running().flatMap(item => item.instance.composer ? [item.instance.composer] : []), transcripts: () => running().flatMap(item => item.instance.transcript ? [item.instance.transcript] : []) };
}
