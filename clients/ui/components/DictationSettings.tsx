import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Plus, Save, Trash2 } from "lucide-solid";
import { useDictationConfiguration } from "../lib/dictation";
import { isMobile } from "../lib/platform";
import type { AppSettings, DictationEngine, SavedDictationEngine, SavedDictationModel } from "../types";
import { IconButton } from "./IconButton";

const engines: Array<{ id: DictationEngine; label: string; program: string; model: string; language: string }> = [
  { id: "transcribe.cpp", label: "transcribe.cpp", program: "transcribe.cpp", model: "~/Models/speech/parakeet-unified-en-0.6b-Q8_0.gguf", language: "Model default" },
  { id: "needle", label: "Cactus Needle (Whistle)", program: "needle", model: "~/Models/speech/whistle.cact", language: "Detect automatically" },
];

const engineLabel = (id: DictationEngine) => engines.find(item => item.id === id)?.label ?? id;
const fileName = (path: string) => path.split("/").pop() || path;

/** Shows the status of the speech engine on this device in one line. */
function DictationStatus() {
  const configuration = useDictationConfiguration();
  const language = () => configuration().language || (configuration().detectLanguage ? "language detected automatically" : "model default language");

  return <div class="dictation-status">
    <Show when={!configuration().loading} fallback={<p role="status"><i class="dictation-dot" />Checking the speech engine…</p>}>
      <Show when={configuration().error} fallback={<Show when={configuration().enabled}>
        <p role="status"><i class="dictation-dot ready" />Ready · {language()}</p>
        <Show when={configuration().languages?.length}><small>The model knows {configuration().languages?.join(", ")}</small></Show>
      </Show>}>
        {(error) => <p role="alert" class="dictation-settings-error"><i class="dictation-dot failed" />{error()}</p>}
      </Show>
    </Show>
  </div>;
}

/** One choice in a list. Click it to use it. Saved choices can be removed; an unsaved one can be saved. */
function Choice(props: { title: string; detail: string; active: boolean; onUse: () => void; onRemove?: () => void; onSave?: () => void }) {
  return <li class={props.active ? "dictation-choice active" : "dictation-choice"}>
    <button type="button" role="radio" aria-checked={props.active} onClick={() => props.onUse()}>
      <i class="dictation-radio" />
      <span><strong>{props.title}</strong><small>{props.detail}</small></span>
    </button>
    <Show when={props.onSave}>{save => <IconButton type="button" label={"Save " + props.title} onClick={() => save()()}><Save size={14} /></IconButton>}</Show>
    <Show when={props.onRemove}>{remove => <IconButton type="button" label={"Remove " + props.title} onClick={() => remove()()}><Trash2 size={14} /></IconButton>}</Show>
  </li>;
}

/** A short inline form that adds one entry. */
function AddForm(props: { hint?: string; children: import("solid-js").JSXElement; canAdd: boolean; onAdd: () => void; onCancel: () => void }) {
  return <div class="dictation-add-form">
    {props.children}
    <div><button type="button" class="primary-button" disabled={!props.canAdd} onClick={() => props.onAdd()}>Add</button><button type="button" class="dictation-link" onClick={() => props.onCancel()}>Cancel</button></div>
    <Show when={props.hint}><small class="dictation-add-hint">{props.hint}</small></Show>
  </div>;
}

export function DictationSettings(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const configuration = useDictationConfiguration();
  const languageList = createUniqueId();
  const engine = () => props.settings.dictationEngine ?? "transcribe.cpp";
  const program = () => props.settings.dictationEnginePath?.trim() ?? "";
  const modelPath = () => props.settings.dictationModelPath?.trim() ?? "";
  const savedEngines = () => props.settings.dictationEngines ?? [];
  const savedModels = () => props.settings.dictationModels ?? [];
  const models = () => savedModels().filter(model => model.engine === engine());
  const engineSaved = () => !program() || savedEngines().some(item => item.path === program() && item.engine === engine());
  const modelSaved = () => !modelPath() || models().some(model => model.path === modelPath());
  /** Languages of the loaded model. They apply only while the form shows the loaded engine. */
  const languages = () => configuration().engine === engine() ? configuration().languages ?? [] : [];

  const [addingEngine, setAddingEngine] = createSignal(false);
  const [newProgram, setNewProgram] = createSignal("");
  /** The engine type of the new program, from its file name: "needle…" is Needle, "python…" is transcribe.cpp. */
  const newEngine = (): DictationEngine | undefined => {
    const name = fileName(newProgram().trim()).toLowerCase();
    return name.startsWith("needle") ? "needle" : name.startsWith("python") ? "transcribe.cpp" : undefined;
  };
  const [addingModel, setAddingModel] = createSignal(false);
  const [newModel, setNewModel] = createSignal("");

  /** Uses an engine. For another engine type, the model becomes the first saved model of that type. */
  const useEngine = (kind: DictationEngine, path: string) => {
    const model = kind === engine() ? undefined : savedModels().find(item => item.engine === kind);
    props.onChange({ dictationEngine: kind, dictationEnginePath: path, ...(kind === engine() ? {} : { dictationModelPath: model?.path ?? "", dictationLanguage: model?.language ?? "" }) });
  };
  const useModel = (model: SavedDictationModel) => props.onChange({ dictationModelPath: model.path, dictationLanguage: model.language ?? "" });
  const withEngine = (item: SavedDictationEngine) => [...savedEngines().filter(entry => entry.path !== item.path), item];
  const withModel = (item: SavedDictationModel) => [...savedModels().filter(entry => entry.path !== item.path), item];
  const language = () => props.settings.dictationLanguage?.trim() || undefined;
  const currentModel = (): SavedDictationModel => ({ engine: engine(), path: modelPath(), ...(language() ? { language: language() } : {}) });

  const addEngine = () => {
    const kind = newEngine();
    if (!kind) return;
    const item = { engine: kind, path: newProgram().trim() };
    const model = item.engine === engine() ? undefined : savedModels().find(entry => entry.engine === item.engine);
    props.onChange({ dictationEngines: withEngine(item), dictationEngine: item.engine, dictationEnginePath: item.path, ...(item.engine === engine() ? {} : { dictationModelPath: model?.path ?? "", dictationLanguage: model?.language ?? "" }) });
    setAddingEngine(false); setNewProgram("");
  };
  const addModel = () => {
    const item: SavedDictationModel = { ...currentModel(), path: newModel().trim() };
    props.onChange({ dictationModels: withModel(item), dictationModelPath: item.path });
    setAddingModel(false); setNewModel("");
  };
  /** The language belongs to the model in use, so a change also updates its saved entry. */
  const setLanguage = (value: string) => {
    const saved = models().some(model => model.path === modelPath());
    props.onChange({ dictationLanguage: value, ...(saved ? { dictationModels: savedModels().map(model => model.path === modelPath() ? { engine: model.engine, path: model.path, ...(value.trim() ? { language: value.trim() } : {}) } : model) } : {}) });
  };

  return <div class="dictation-settings">
    <section class="dictation-group">
      <h3>Engine</h3>
      <ul class="dictation-choices" role="radiogroup" aria-label="Dictation engine">
        <For each={engines}>{kind => <>
          <Choice title={kind.label} detail={isMobile ? "Built into the app" : "Find " + kind.program + " automatically"} active={engine() === kind.id && !program()} onUse={() => useEngine(kind.id, "")} />
          <Show when={!isMobile}>
            <For each={savedEngines().filter(item => item.engine === kind.id)}>{item => <Choice title={kind.label} detail={item.path} active={engine() === item.engine && program() === item.path} onUse={() => useEngine(item.engine, item.path)}
              onRemove={() => props.onChange({ dictationEngines: savedEngines().filter(entry => entry.path !== item.path), ...(program() === item.path ? { dictationEnginePath: "" } : {}) })} />}</For>
            <Show when={engine() === kind.id && !engineSaved()}><Choice title={kind.label} detail={program() + " · not saved"} active onUse={() => undefined} onSave={() => props.onChange({ dictationEngines: withEngine({ engine: engine(), path: program() }) })} /></Show>
          </Show>
        </>}</For>
      </ul>
      <Show when={!isMobile}>
        <Show when={addingEngine()} fallback={<button type="button" class="dictation-link" onClick={() => setAddingEngine(true)}><Plus size={14} />Add engine</button>}>
          <AddForm hint={newProgram().trim() ? (newEngine() ? "Engine: " + engineLabel(newEngine()!) : "Unknown program. The file name must start with needle or python.") : undefined} canAdd={newEngine() !== undefined} onAdd={addEngine} onCancel={() => setAddingEngine(false)}>
            <input aria-label="New engine program path" autofocus placeholder="Path to needle, or to the Python of transcribe.cpp" value={newProgram()} onInput={event => setNewProgram(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && newEngine()) addEngine(); if (event.key === "Escape") setAddingEngine(false); }} />
          </AddForm>
        </Show>
      </Show>
    </section>
    <section class="dictation-group">
      <h3>Model</h3>
      <ul class="dictation-choices" role="radiogroup" aria-label="Dictation model">
        <For each={models()}>{model => <Choice title={fileName(model.path)} detail={model.path} active={modelPath() === model.path} onUse={() => useModel(model)}
          onRemove={() => props.onChange({ dictationModels: savedModels().filter(entry => entry.path !== model.path), ...(modelPath() === model.path ? { dictationModelPath: "" } : {}) })} />}</For>
        <Show when={!modelSaved()}><Choice title={fileName(modelPath())} detail={modelPath() + " · not saved"} active onUse={() => undefined} onSave={() => props.onChange({ dictationModels: withModel(currentModel()) })} /></Show>
      </ul>
      <Show when={!models().length && modelSaved()}><p class="dictation-empty">No models for {engineLabel(engine())} yet.</p></Show>
      <Show when={addingModel()} fallback={<button type="button" class="dictation-link" onClick={() => setAddingModel(true)}><Plus size={14} />Add model</button>}>
        <AddForm canAdd={!!newModel().trim()} onAdd={addModel} onCancel={() => setAddingModel(false)}>
          <input aria-label="New model file path" autofocus placeholder={engines.find(item => item.id === engine())?.model} value={newModel()} onInput={event => setNewModel(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && newModel().trim()) addModel(); if (event.key === "Escape") setAddingModel(false); }} />
        </AddForm>
      </Show>
      <label class="field dictation-language"><span>Language</span><input aria-label="Dictation language" list={languageList} placeholder={engines.find(item => item.id === engine())?.language} value={props.settings.dictationLanguage ?? ""} onInput={event => setLanguage(event.currentTarget.value)} /></label>
      <datalist id={languageList}><For each={languages()}>{item => <option value={item} />}</For></datalist>
    </section>
    <DictationStatus />
  </div>;
}
