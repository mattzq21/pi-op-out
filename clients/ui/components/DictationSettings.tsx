import { createUniqueId, For, Show } from "solid-js";
import { CirclePlus, Trash2 } from "lucide-solid";
import { useDictationConfiguration } from "../lib/dictation";
import { isMobile } from "../lib/platform";
import type { AppSettings, DictationEngine, SavedDictationEngine, SavedDictationModel } from "../types";
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

/** One saved model or engine. "Use" puts it in the form. */
function SavedRow(props: { name: string; details: string[]; active: boolean; onUse: () => void; onRemove: () => void }) {
  return <li class="dictation-saved-model">
    <span><strong>{props.name}</strong><For each={props.details}>{line => <small>{line}</small>}</For></span>
    <button type="button" class="secondary-button" disabled={props.active} onClick={() => props.onUse()}>{props.active ? "In use" : "Use"}</button>
    <IconButton type="button" label={"Remove " + props.name} onClick={() => props.onRemove()}><Trash2 size={15} /></IconButton>
  </li>;
}

const fileName = (path: string) => path.split("/").pop() || path;
const engineLabel = (id: DictationEngine) => engines.find(item => item.id === id)?.label ?? id;

export function DictationSettings(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const configuration = useDictationConfiguration();
  const languageList = createUniqueId();
  const engine = () => engines.find(item => item.id === (props.settings.dictationEngine ?? "transcribe.cpp")) ?? engines[0];
  /** Languages of the loaded model. They apply only while the form shows the loaded engine. */
  const languages = () => configuration().engine === engine().id ? configuration().languages ?? [] : [];

  const savedEngines = () => props.settings.dictationEngines ?? [];
  const programPath = () => props.settings.dictationEnginePath?.trim() ?? "";
  const engineActive = (item: SavedDictationEngine) => item.path === programPath() && item.engine === engine().id;
  const currentEngine = () => savedEngines().find(item => item.path === programPath());
  /** Adds the engine in the form to the list. An engine with the same program path is replaced. */
  const saveEngine = () => {
    const item: SavedDictationEngine = { engine: engine().id, path: programPath() };
    props.onChange({ dictationEngines: currentEngine() ? savedEngines().map(entry => entry.path === item.path ? item : entry) : [...savedEngines(), item] });
  };

  const savedModels = () => props.settings.dictationModels ?? [];
  const modelPath = () => props.settings.dictationModelPath?.trim() ?? "";
  const language = () => props.settings.dictationLanguage?.trim() || undefined;
  const modelActive = (model: SavedDictationModel) => model.path === modelPath() && model.engine === engine().id && model.language === language();
  const currentModel = () => savedModels().find(model => model.path === modelPath());
  /** Adds the model in the form to the list. A model with the same path is replaced. */
  const saveModel = () => {
    const model: SavedDictationModel = { engine: engine().id, path: modelPath(), ...(language() ? { language: language() } : {}) };
    props.onChange({ dictationModels: currentModel() ? savedModels().map(item => item.path === model.path ? model : item) : [...savedModels(), model] });
  };
  /** Uses a saved model. For another engine type, the program becomes the first saved engine of that type, or automatic search. */
  const useModel = (model: SavedDictationModel) => props.onChange({
    dictationEngine: model.engine, dictationModelPath: model.path, dictationLanguage: model.language ?? "",
    ...(model.engine === engine().id ? {} : { dictationEnginePath: savedEngines().find(item => item.engine === model.engine)?.path ?? "" }),
  });

  return <>
    <Show when={!isMobile}><div class="field"><span>Saved engines</span>
      <Show when={savedEngines().length} fallback={<small>No saved engines. Fill in the engine below and save it.</small>}>
        <ul class="dictation-saved-models"><For each={savedEngines()}>{item => <SavedRow name={engineLabel(item.engine)} details={[item.path]} active={engineActive(item)}
          onUse={() => props.onChange({ dictationEngine: item.engine, dictationEnginePath: item.path })}
          onRemove={() => props.onChange({ dictationEngines: savedEngines().filter(entry => entry.path !== item.path) })} />}</For></ul>
      </Show>
    </div></Show>
    <label class="field"><span>Engine</span><select aria-label="Dictation engine" value={engine().id} onChange={event => props.onChange({ dictationEngine: event.currentTarget.value as DictationEngine })}>{engines.map(item => <option value={item.id}>{item.label}</option>)}</select></label>
    <Show when={!isMobile}>
      <label class="field"><span>Program path</span><input aria-label="Dictation program path" placeholder={`Find ${engine().program} automatically`} value={props.settings.dictationEnginePath ?? ""} onInput={event => props.onChange({ dictationEnginePath: event.currentTarget.value })} /></label>
      <button type="button" class="secondary-button" disabled={!programPath() || (currentEngine() !== undefined && engineActive(currentEngine()!))} onClick={saveEngine}><CirclePlus size={15} />{currentEngine() ? "Update saved engine" : "Save this engine"}</button>
    </Show>
    <div class="field"><span>Saved models</span>
      <Show when={savedModels().length} fallback={<small>No saved models. Fill in the model below and save it.</small>}>
        <ul class="dictation-saved-models"><For each={savedModels()}>{model => <SavedRow name={fileName(model.path)} details={[engineLabel(model.engine) + (model.language ? " · " + model.language : ""), model.path]} active={modelActive(model)}
          onUse={() => useModel(model)}
          onRemove={() => props.onChange({ dictationModels: savedModels().filter(item => item.path !== model.path) })} />}</For></ul>
      </Show>
    </div>
    <label class="field"><span>Model file path</span><input aria-label="Dictation model file path" placeholder={engine().model} value={props.settings.dictationModelPath ?? ""} onInput={event => props.onChange({ dictationModelPath: event.currentTarget.value })} /></label>
    <label class="field"><span>Language</span><input aria-label="Dictation language" list={languageList} placeholder={engine().language} value={props.settings.dictationLanguage ?? ""} onInput={event => props.onChange({ dictationLanguage: event.currentTarget.value })} /></label>
    <datalist id={languageList}><For each={languages()}>{item => <option value={item} />}</For></datalist>
    <button type="button" class="secondary-button" disabled={!modelPath() || (currentModel() !== undefined && modelActive(currentModel()!))} onClick={saveModel}><CirclePlus size={15} />{currentModel() ? "Update saved model" : "Save this model"}</button>
    <DictationStatus />
  </>;
}
