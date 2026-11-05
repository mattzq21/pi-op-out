import { createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, untrack, type Accessor } from "solid-js";
import { z } from "zod";
import { listen } from "../lib/platform";
import { pluginError, pluginName, pluginStatus, refreshPlugins, setPluginError } from ".";
import type { PluginScope } from "../../../protocol/plugins";
import type { PluginConversation, PluginInstance } from "./types";
import { flushPlugins, registerPluginReadiness } from "./lifecycle";
import { pluginClient } from "./clientModules";

interface ClientPlugin { id: string; host: string; scope: PluginScope }

interface RunningPlugin { id: string; host: string; revision: string | undefined; instance: PluginInstance; dispose: () => void }

export type PluginWorkspace = ReturnType<typeof createPluginWorkspace>;

export function createPluginWorkspace(source: Accessor<PluginConversation>) {
  const [running, setRunning] = createSignal<RunningPlugin[]>([]);
  const [loadError, setLoadError] = createSignal<string>();
  const owner = getOwner();
  let generation = 0;
  let disposed = false;
  let loading: Promise<void> = Promise.resolve();
  let loadingFailures: { host: string; message: string }[] = [];
  const host = createMemo(() => source().hostId);
  // Plugins of the "client" scope come from the local host; the others from the conversation's host.
  const hosts = createMemo(() => [...new Set([host(), "local"])]);
  const conversationReady = createMemo(() => Boolean(source().sessionId) && (source().messageCount ?? 0) > 0);

  const enabledPlugins = createMemo<ClientPlugin[]>(() => {
    // In the loading order of the host.
    const of = (target: string, scopes: PluginScope[]) => {
      const status = pluginStatus(target);

      return (status?.enabled ?? []).flatMap(id => {
        const plugin = status?.plugins.find(item => item.id === id);

        return plugin?.client && scopes.includes(plugin.client.scope) ? [{ id, host: target, scope: plugin.client.scope }] : [];
      });
    };

    return [...of(host(), conversationReady() ? ["host", "conversation"] : ["host"]), ...of("local", ["client"])];
  });

  const configuration = createMemo(() => JSON.stringify([
    host(), hosts().map(target => [target, pluginStatus(target)?.revision]), enabledPlugins().map(plugin => [plugin.host, plugin.id]),
  ]));

  const error = () => loadError() ?? hosts().map(pluginError).filter(Boolean).join("\n");

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
    const enabled = untrack(() => enabledPlugins().map(plugin => ({ plugin, revision: pluginStatus(plugin.host)?.revision })));
    const configurationHost = untrack(host);
    const current = ++generation;
    const previous = untrack(running);
    const targets = [...new Set([...untrack(hosts), ...previous.map(item => item.host)])];
    const stale = () => disposed || current !== generation;

    loading = (async () => {
      await untrack(() => Promise.all(targets.map(target => flushPlugins(target, pluginStatus(target)?.enabled))));

      if (stale()) return;
      const retained = previous.filter(item => enabled.some(target => target.plugin.id === item.id && target.plugin.host === item.host && target.revision === item.revision));
      setRunning(retained);

      for (const item of previous) if (!retained.includes(item)) item.dispose();
      const next = [...retained];
      const failures: { host: string; message: string }[] = [];

      for (const { plugin, revision } of enabled) {
        if (stale()) return;
        if (retained.some(item => item.id === plugin.id && item.host === plugin.host)) continue;

        try {
          const module = await pluginClient(plugin.host, plugin.id);

          if (stale()) return;
          const createPlugin = module?.createPlugin;

          if (!createPlugin) continue;
          next.push(createRoot(dispose => {
            try {
              return { id: plugin.id, host: plugin.host, revision, dispose, instance: createPlugin({ source }) };
            } catch (reason) { dispose(); throw reason; }
          }, owner));
          setRunning([...next]);
        } catch (reason) {
          const affected = new Set([configurationHost, plugin.host]);
          failures.push(...[...affected].map(target => ({ host: target, message: `${pluginName(plugin.host, plugin.id)}: ${(reason instanceof Error ? reason.message : String(reason))}` })));
        }
      }

      if (stale()) return;
      loadingFailures = failures;
      setRunning(enabled.flatMap(({ plugin }) => next.filter(item => item.id === plugin.id && item.host === plugin.host)));

      setLoadError(failures.length ? `Plugins could not load: ${[...new Set(failures.map(failure => failure.message))].join("\n")}` : undefined);
    })().catch(reason => { if (current === generation) {
      loadingFailures = hosts().map(target => ({ host: target, message: reason instanceof Error ? reason.message : String(reason) }));
      setLoadError(`Plugins could not load: ${(reason instanceof Error ? reason.message : String(reason))}`);
    } });
  });
  onCleanup(() => { disposed = true; generation++;

  for (const item of running()) item.dispose(); void listener.then(stop => stop()); });

  return { error, composers: () => running().flatMap(item => item.instance.composer ? [item.instance.composer] : []), transcripts: () => running().flatMap(item => item.instance.transcript ? [item.instance.transcript] : []) };
}
