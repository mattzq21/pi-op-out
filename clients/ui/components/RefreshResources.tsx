import { createSignal, onCleanup, Show } from "solid-js";
import { RefreshCw } from "lucide-solid";
import { nativeCall } from "../lib/nativeCall";
import { appSettingsSchema } from "../lib/responseSchemas";
import type { AppSettings } from "../types";

/** A button that has a host find its skills or tools again, then hands over the reloaded settings. */
function RefreshResource(props: { hostId: string; resource: "skills" | "tools"; onRefresh: (settings: AppSettings) => void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const refresh = async () => {
    setBusy(true); setError(undefined);
    const hostId = props.hostId;

    try {
      const flag = props.resource === "skills" ? { refreshSkills: true } : { refreshTools: true };
      const settings = await nativeCall(hostId === "local" ? "load_app_settings" : "load_host_settings", { hostId, ...flag }, appSettingsSchema);

      if (disposed || hostId !== props.hostId) return;
      props.onRefresh(settings);
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setBusy(false); }
  };

  return <span class="refresh-resource">
    <button type="button" aria-label={`Refresh ${props.resource}`} data-tooltip={busy() ? `Refreshing ${props.resource}…` : `Refresh ${props.resource}`} disabled={busy()} onClick={() => void refresh()}><RefreshCw size={13} class={busy() ? "spinning" : ""} aria-hidden="true" /></button>
    <Show when={error()}><span role="alert">{error()}</span></Show>
  </span>;
}

export function RefreshSkills(props: { hostId: string; skills: AppSettings["skills"]; onChange: (skills: AppSettings["skills"]) => void }) {
  return <RefreshResource hostId={props.hostId} resource="skills" onRefresh={settings => {
    const enabled = new Map(props.skills.map(skill => [skill.path, skill.enabled]));
    props.onChange(settings.skills.map(skill => ({ ...skill, enabled: enabled.get(skill.path) ?? skill.enabled })));
  }} />;
}

/** Starts a short Pi session on the host so it reports its tools. */
export function RefreshTools(props: { hostId: string; onChange: (tools: AppSettings["tools"]) => void }) {
  return <RefreshResource hostId={props.hostId} resource="tools" onRefresh={settings => props.onChange(settings.tools)} />;
}
