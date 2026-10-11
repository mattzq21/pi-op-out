import { Show } from "solid-js";
import { useDictationConfiguration } from "../lib/dictation";
import type { AppSettings, DictationEngine } from "../types";

const engines: Array<{ id: DictationEngine; label: string; program: string; model: string }> = [
  { id: "transcribe.cpp", label: "transcribe.cpp", program: "transcribe-cli", model: "~/Models/speech-model.gguf" },
  { id: "needle", label: "Cactus Needle (Whistle)", program: "needle", model: "~/Models/whistle.cact" },
];

/** Shows the saved engine status of the connected daemon. */
function DictationStatus() {
  const configuration = useDictationConfiguration();

  return <Show when={configuration().loading} fallback={
    <Show when={configuration().error} fallback={<Show when={configuration().enabled}><p role="status">Ready: {configuration().engine} at {configuration().executable}</p></Show>}>
      {(error) => <p role="alert" class="dictation-settings-error">{error()}</p>}
    </Show>
  }><p role="status">Checking the speech engine…</p></Show>;
}

export function DictationSettings(props: { settings: AppSettings; showStatus: boolean; onChange: (patch: Partial<AppSettings>) => void }) {
  const engine = () => engines.find(item => item.id === (props.settings.dictationEngine ?? "transcribe.cpp")) ?? engines[0];

  return <>
    <label class="field"><span>Engine</span><select aria-label="Dictation engine" value={engine().id} onChange={event => props.onChange({ dictationEngine: event.currentTarget.value as DictationEngine })}>{engines.map(item => <option value={item.id}>{item.label}</option>)}</select></label>
    <label class="field"><span>Program path</span><input aria-label="Dictation program path" placeholder={`Find ${engine().program} automatically`} value={props.settings.dictationEnginePath ?? ""} onInput={event => props.onChange({ dictationEnginePath: event.currentTarget.value })} /></label>
    <label class="field"><span>Model file path</span><input aria-label="Dictation model file path" placeholder={engine().model} value={props.settings.dictationModelPath ?? ""} onInput={event => props.onChange({ dictationModelPath: event.currentTarget.value })} /></label>
    <Show when={props.showStatus}><DictationStatus /></Show>
  </>;
}
