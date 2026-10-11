import { createUniqueId, For, Show } from "solid-js";
import { CirclePlus, Trash2 } from "lucide-solid";
import { useDictationConfiguration } from "../lib/dictation";
import { isMobile } from "../lib/platform";
import type { AppSettings, DictationEngine, SavedDictationModel } from "../types";
import { IconButton } from "./IconButton";

const engines: Array<{ id: DictationEngine; label: string; program: string; model: string; language: string }> = [
  { id: "transcribe.cpp", label: "transcribe.cpp", program: "transcribe.cpp", model: "~/Models/speech/parakeet-unified-en-0.6b-Q8_0.gguf", language: "Model default" },
  { id: "needle", label: "Cactus Needle (Whistle)", program: "needle", model: "~/Models/whistle.cact", language: "Detect automatically" },
];

/** Shows the status of the speech engine on this device. */
function DictationStatus() {
  const configuration = useDictationConfiguration();
  const language = () => configuration().language || (configuration().detectLanguage ? "detected automatically" : "model default");

  return <Show when={configuration().loading} fallback={
    <Show when={configuration().error} fallback={<Show when={configuration().enabled}>
      <p role="status">Ready: {configuration().engine}{configuration().executable ? ` at ${configuration().executable}` : ""}. Language: {language()}.</p>
      <Show when={configuration().languages?.length}><p>The model knows: {configuration().languages?.join(", ")}</p></Show>
    </Show>}>
      {(error) => <p role="alert" class="dictation-settings-error">{error()}</p>}
    </Show>
  }><p role="status">Checking the speech engine…</p></Show>;
}

/** One saved model. "Use" puts its engine, path and language in the form. */
function SavedModelRow(props: { model: SavedDictationModel; active: boolean; onUse: () => void; onRemove: () => void }) {
  const name = () => props.model.path.split("/").pop() || props.model.path;
  const label = () => engines.find(item => item.id === props.model.engine)?.label ?? props.model.engine;

  return <li class="dictation-saved-model">
    <span><strong>{name()}</strong><small>{label()}{props.model.language ? " · " + props.model.language : ""}</small><small>{props.model.path}</small></span>
    <button type="button" class="secondary-button" disabled={props.active} onClick={() => props.onUse()}>{props.active ? "In use" : "Use"}</button>
    <IconButton type="button" label={"Remove " + name()} onClick={() => props.onRemove()}><Trash2 size={15} /></IconButton>
  </li>;
}

export function DictationSettings(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const configuration = useDictationConfiguration();
  const languageList = createUniqueId();
  const engine = () => engines.find(item => item.id === (props.settings.dictationEngine ?? "transcribe.cpp")) ?? engines[0];
  /** Languages of the loaded model. They apply only while the form shows the loaded engine. */
  const languages = () => configuration().engine === engine().id ? configuration().languages ?? [] : [];
  const saved = () => props.settings.dictationModels ?? [];
  const modelPath = () => props.settings.dictationModelPath?.trim() ?? "";
  const language = () => props.settings.dictationLanguage?.trim() || undefined;
  const active = (model: SavedDictationModel) => model.path === modelPath() && model.engine === engine().id && model.language === language();
  const current = () => saved().find(model => model.path === modelPath());
  /** Adds the model in the form to the list. A model with the same path is replaced. */
  const saveCurrent = () => {
    const model: SavedDictationModel = { engine: engine().id, path: modelPath(), ...(language() ? { language: language() } : {}) };
    props.onChange({ dictationModels: current() ? saved().map(item => item.path === model.path ? model : item) : [...saved(), model] });
  };

  return <>
    <div class="field"><span>Saved models</span>
      <Show when={saved().length} fallback={<small>No saved models. Fill in the model below and save it.</small>}>
        <ul class="dictation-saved-models"><For each={saved()}>{model => <SavedModelRow model={model} active={active(model)}
          onUse={() => props.onChange({ dictationEngine: model.engine, dictationModelPath: model.path, dictationLanguage: model.language ?? "" })}
          onRemove={() => props.onChange({ dictationModels: saved().filter(item => item.path !== model.path) })} />}</For></ul>
      </Show>
    </div>
    <label class="field"><span>Engine</span><select aria-label="Dictation engine" value={engine().id} onChange={event => props.onChange({ dictationEngine: event.currentTarget.value as DictationEngine })}>{engines.map(item => <option value={item.id}>{item.label}</option>)}</select></label>
    <Show when={!isMobile}><label class="field"><span>Program path</span><input aria-label="Dictation program path" placeholder={`Find ${engine().program} automatically`} value={props.settings.dictationEnginePath ?? ""} onInput={event => props.onChange({ dictationEnginePath: event.currentTarget.value })} /></label></Show>
    <label class="field"><span>Model file path</span><input aria-label="Dictation model file path" placeholder={engine().model} value={props.settings.dictationModelPath ?? ""} onInput={event => props.onChange({ dictationModelPath: event.currentTarget.value })} /></label>
    <label class="field"><span>Language</span><input aria-label="Dictation language" list={languageList} placeholder={engine().language} value={props.settings.dictationLanguage ?? ""} onInput={event => props.onChange({ dictationLanguage: event.currentTarget.value })} /></label>
    <datalist id={languageList}><For each={languages()}>{item => <option value={item} />}</For></datalist>
    <button type="button" class="secondary-button" disabled={!modelPath() || (current() !== undefined && active(current()!))} onClick={saveCurrent}><CirclePlus size={15} />{current() ? "Update saved model" : "Save this model"}</button>
    <DictationStatus />
  </>;
}
