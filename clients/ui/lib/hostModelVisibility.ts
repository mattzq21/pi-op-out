import type { Accessor } from "solid-js";
import { onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { z } from "zod";
import type { AppSettings, Model, SettingsChange } from "../types";
import { observeModelConnections } from "./modelReports";
import { recordSeenModels } from "./modelVisibility";
import { NativeTransport } from "./nativeTransport";
import { listen } from "./platform";
import { settingsChangeSchema } from "./responseSchemas";

type Visibility = Pick<AppSettings, "hiddenModels" | "knownModels" | "modelAliases">;
type Notice = (notice: { title: string; message: string }) => void;

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** Model visibility of each machine. "local" comes from the local daemon settings; remote machines load on first use. */
export function createHostModelVisibility(localSettings: Accessor<AppSettings | undefined>, addNotice: Notice, saveLocal?: (settings: AppSettings, baseline: AppSettings) => Promise<SettingsChange>) {
  const [remote, setRemote] = createStore<Record<string, Visibility>>({});
  const loading = new Set<string>();
  const failed = new Set<string>();
  const retrying = new Set<string>();
  const recording = new Map<string, Promise<void>>();
  const retryReports = new Set<string>();
  const pending = new Map<string, string[]>();
  const versions = new Map<string, number>();
  const snapshots = new Map<string, AppSettings>();
  let disposed = false;

  const version = (hostId: string) => versions.get(hostId) ?? 0;
  const store = (hostId: string, settings: AppSettings) => {
    if (disposed) return;
    versions.set(hostId, version(hostId) + 1);
    snapshots.set(hostId, settings);
    failed.delete(hostId);
    setRemote(hostId, reconcile({ modelAliases: settings.modelAliases ?? {}, hiddenModels: settings.hiddenModels, knownModels: settings.knownModels }));
  };

  const load = (hostId: string) => {
    if (disposed || loading.has(hostId) || failed.has(hostId)) return;
    loading.add(hostId);
    const reader = new NativeTransport({ hostId, cwd: "~" });
    const started = version(hostId);
    void reader.loadHostSettings().then(settings => { if (started === version(hostId)) store(hostId, settings); }, reason => {
      if (disposed || retrying.has(hostId) || started !== version(hostId)) return;
      failed.add(hostId);
      addNotice({ title: "Could not load model list", message: `Visible models of ${hostId}: ${message(reason)}` });
    }).finally(() => {
      loading.delete(hostId); void dispose(reader, hostId);

      if (retrying.delete(hostId)) load(hostId);
    });
  };

  const dispose = (transport: NativeTransport, hostId: string) => transport.dispose().catch(reason => addNotice({ title: "Could not close model settings connection", message: `${hostId}: ${message(reason)}` }));
  const reportWarnings = (hostId: string, change: SettingsChange) => {
    if (change.warnings?.length) addNotice({ title: "Settings synchronization pending", message: `${hostId}: ${change.warnings.join("\n")}` });

    if (change.settings.settingsDurabilityError) addNotice({ title: "Settings need a save retry", message: `${hostId}: ${change.settings.settingsDurabilityError}. Open settings and retry saving.` });
  };
  const retryReport = (hostId: string) => {
    if (!pending.has(hostId)) return;
    if (recording.has(hostId)) { retryReports.add(hostId); return; }
    recordSeen(hostId, []);
  };
  const receive = (hostId: string, change: SettingsChange) => { store(hostId, change.settings); retryReport(hostId); };
  const unlisten = listen("pi://host-settings-changed", ({ payload }) => receive(payload.hostId, payload), settingsChangeSchema.extend({ hostId: z.string() }));
  const unlistenLocal = listen("pi://settings-changed", ({ payload }) => receive("local", payload), settingsChangeSchema);
  const stopConnections = observeModelConnections(hostId => {
    retryReport(hostId);
    if (loading.has(hostId)) { retrying.add(hostId); return; }

    if (!failed.delete(hostId)) return;
    load(hostId);
  });
  onCleanup(() => { disposed = true; stopConnections(); void unlisten.then(stop => stop()); void unlistenLocal.then(stop => stop()); });

  /** Hidden model ids of the machine, or undefined while they load. */
  const hidden = (hostId: string): readonly string[] | undefined => {
    if (hostId === "local") return localSettings()?.hiddenModels;
    const value = remote[hostId];

    if (!value) load(hostId);

    return value?.hiddenModels;
  };

  /** Hide models that the machine reports for the first time. */
  const recordSeen = (hostId: string, ids: string[], retry = true): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (ids.length) pending.set(hostId, [...new Set([...(pending.get(hostId) ?? []), ...ids])]);
    const active = recording.get(hostId);

    if (active) return active;
    if (!pending.has(hostId)) return Promise.resolve();
    const writer = new NativeTransport({ hostId, cwd: "~" });
    const operation = (async () => {
      while (!disposed && pending.has(hostId)) {
        const report = pending.get(hostId)!;
        const started = version(hostId);
        const loaded = await writer.loadHostSettings();

        if (disposed) return;
        const latest = started === version(hostId) ? loaded : snapshots.get(hostId)!;
        const next = recordSeenModels(latest, report);

        if (next) {
          const saving = version(hostId);
          const local = hostId === "local" && saveLocal;
          const change = local ? await saveLocal(next, latest) : await writer.saveHostSettings(next);

          if (!local) reportWarnings(hostId, change);

          if (saving === version(hostId)) store(hostId, change.settings);
        } else if (started === version(hostId)) store(hostId, latest);
        const remaining = pending.get(hostId)!.filter(id => !report.includes(id));

        if (remaining.length) pending.set(hostId, remaining);
        else pending.delete(hostId);
      }
    })().finally(() => {
      void dispose(writer, hostId);
      recording.delete(hostId);
      const requested = retryReports.delete(hostId);

      if (retry && requested && pending.has(hostId)) recordSeen(hostId, [], false);
    });
    recording.set(hostId, operation);
    void operation.catch(reason => addNotice({ title: "Could not save model list", message: `${hostId}: ${message(reason)}` }));

    return operation;
  };

  const visibleModels = (hostId: string, models: Model[]) => {
    const hiddenModels = hidden(hostId);
    const knownModels = hostId === "local" ? localSettings()?.knownModels : remote[hostId]?.knownModels;

    return hiddenModels ? models.filter(model => {
      const id = `${model.provider}/${model.id}`;

      return !hiddenModels.includes(id) && (knownModels === undefined || knownModels.includes(id));
    }) : [];
  };

  const aliases = (hostId: string) => {
    if (hostId === "local") return localSettings()?.modelAliases;
    if (!remote[hostId]) load(hostId);
    return remote[hostId]?.modelAliases;
  };

  return { hidden, visibleModels, recordSeen, aliases };
}

export type HostModelVisibility = ReturnType<typeof createHostModelVisibility>;
