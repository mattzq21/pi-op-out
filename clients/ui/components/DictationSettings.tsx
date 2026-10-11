import { createUniqueId, For, Show } from "solid-js";
import { useDictationConfiguration } from "../lib/dictation";
import type { AppSettings, DictationEngine } from "../types";

const engines: Array<{ id: DictationEngine; label: string; program: string; model: string; language: string }> = [
  { id: "transcribe.cpp", label: "transcribe.cpp", program: "transcribe.cpp", model: "~/Models/speech/parakeet-unified-en-0.6b-Q8_0.gguf", language: "Model default" },
  { id: "needle", label: "Cactus Needle (Whistle)", program: "needle", model: "~/Models/whistle.cact", language: "Detect automatically" },
];

/** Shows the saved engine status of the connected daemon. */
function DictationStatus() {
  const configuration = useDictationConfiguration();
  const language = () => configuration().language || (configuration().detectLanguage ? "detected automatically" : "model default");

  return <Show when={configuration().loading} fallback={
    <Show when={configuration().error} fallback={<Show when={configuration().enabled}>
      <p role="status">Ready: {configuration().engine} at {configuration().executable}. Language: {language()}.</p>
      <Show when={configuration().languages?.length}><p>The model knows: {configuration().languages?.join(", ")}</p></Show>
    </Show>}>
      {(error) => <p role="alert" class="dictation-settings-error">{error()}</p>}
    </Show>
  }><p role="status">Checking the speech engine…</p></Show>;
}

export function DictationSettings(props: { settings: AppSettings; showStatus: boolean; onChange: (patch: Partial<AppSettings>) => void }) {
  const configuration = useDictationConfiguration();
  const languageList = createUniqueId();
  const engine = () => engines.find(item => item.id === (props.settings.dictationEngine ?? "transcribe.cpp")) ?? engines[0];
  /** Languages of the loaded model. They apply only while the form shows the loaded engine. */
  const languages = () => configuration().engine === engine().id ? configuration().languages ?? [] : [];

  return <>
    <label class="field"><span>Engine</span><select aria-label="Dictation engine" value={engine().id} onChange={event => props.onChange({ dictationEngine: event.currentTarget.value as DictationEngine })}>{engines.map(item => <option value={item.id}>{item.label}</option>)}</select></label>
    <label class="field"><span>Program path</span><input aria-label="Dictation program path" placeholder={`Find ${engine().program} automatically`} value={props.settings.dictationEnginePath ?? ""} onInput={event => props.onChange({ dictationEnginePath: event.currentTarget.value })} /></label>
    <label class="field"><span>Model file path</span><input aria-label="Dictation model file path" placeholder={engine().model} value={props.settings.dictationModelPath ?? ""} onInput={event => props.onChange({ dictationModelPath: event.currentTarget.value })} /></label>
    <label class="field"><span>Language</span><input aria-label="Dictation language" list={languageList} placeholder={engine().language} value={props.settings.dictationLanguage ?? ""} onInput={event => props.onChange({ dictationLanguage: event.currentTarget.value })} /></label>
    <datalist id={languageList}><For each={languages()}>{item => <option value={item} />}</For></datalist>
    <Show when={props.showStatus}><DictationStatus /></Show>
  </>;
}
