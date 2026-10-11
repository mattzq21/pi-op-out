import type { Accessor } from "solid-js";
import { onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { z } from "zod";
import type { AppSettings } from "../types";
import { recordSeenModels } from "./modelVisibility";
import { NativeTransport } from "./nativeTransport";
import { listen } from "./platform";
import { appSettingsSchema } from "./responseSchemas";

type Visibility = Pick<AppSettings, "hiddenModels" | "knownModels">;
type Notice = (notice: { title: string; message: string }) => void;

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** Model visibility of each machine. "local" comes from the local daemon settings; remote machines load on first use. */
export function createHostModelVisibility(localSettings: Accessor<AppSettings | undefined>, addNotice: Notice) {
  const [remote, setRemote] = createStore<Record<string, Visibility>>({});
  const loading = new Set<string>();
  const failed = new Set<string>();
  const recording = new Set<string>();

  const store = (hostId: string, settings: AppSettings) => setRemote(hostId, { hiddenModels: settings.hiddenModels, knownModels: settings.knownModels });

  const load = (hostId: string) => {
    if (loading.has(hostId) || failed.has(hostId)) return;
    loading.add(hostId);
    const reader = new NativeTransport({ hostId, cwd: "~" });
    void reader.loadHostSettings().then(settings => store(hostId, settings), reason => {
      failed.add(hostId);
      addNotice({ title: "Could not load model list", message: `Visible models of ${hostId}: ${message(reason)}` });
    }).finally(() => { loading.delete(hostId); void reader.dispose().catch(() => undefined); });
  };

  const unlisten = listen("pi://host-settings-changed", ({ payload }) => { failed.delete(payload.hostId); store(payload.hostId, payload.settings); }, z.object({ hostId: z.string(), settings: appSettingsSchema }));
  onCleanup(() => { void unlisten.then(stop => stop()); });

  /** Hidden model ids of the machine, or undefined while they load. */
  const hidden = (hostId: string): readonly string[] | undefined => {
    if (hostId === "local") return localSettings()?.hiddenModels;
    const value = remote[hostId];

    if (!value) load(hostId);

    return value?.hiddenModels;
  };

  /** Hide models that the remote machine reports for the first time. */
  const recordSeen = (hostId: string, ids: string[]) => {
    const known = remote[hostId]?.knownModels;

    if (!remote[hostId] || recording.has(hostId) || (known && ids.every(id => known.includes(id)))) return;
    recording.add(hostId);
    const writer = new NativeTransport({ hostId, cwd: "~" });
    void (async () => {
      const latest = await writer.loadHostSettings();
      const next = recordSeenModels(latest, ids);

      if (!next) { store(hostId, latest); return; }
      store(hostId, (await writer.saveHostSettings(next)).settings);
    })().catch(reason => addNotice({ title: "Could not save model list", message: `${hostId}: ${message(reason)}` }))
      .finally(() => { recording.delete(hostId); void writer.dispose().catch(() => undefined); });
  };

  return { hidden, recordSeen };
}

export type HostModelVisibility = ReturnType<typeof createHostModelVisibility>;
