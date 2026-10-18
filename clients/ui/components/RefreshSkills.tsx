import { createSignal, onCleanup, Show } from "solid-js";
import { nativeCall } from "../lib/nativeCall";
import { appSettingsSchema } from "../lib/responseSchemas";
import type { AppSettings } from "../types";

export function RefreshSkills(props: { hostId: string; skills: AppSettings["skills"]; onChange: (skills: AppSettings["skills"]) => void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const refresh = async () => {
    setBusy(true); setError(undefined);
    const hostId = props.hostId;

    try {
      const settings = await nativeCall(hostId === "local" ? "load_app_settings" : "load_host_settings", { hostId, refreshSkills: true }, appSettingsSchema);

      if (disposed || hostId !== props.hostId) return;
      const enabled = new Map(props.skills.map(skill => [skill.path, skill.enabled]));
      props.onChange(settings.skills.map(skill => ({ ...skill, enabled: enabled.get(skill.path) ?? skill.enabled })));
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setBusy(false); }
  };

  return <div><button type="button" class="secondary-button" disabled={busy()} onClick={() => void refresh()}>{busy() ? "Refreshing skills…" : "Refresh skills"}</button><Show when={error()}><p role="alert">{error()}</p></Show></div>;
}
