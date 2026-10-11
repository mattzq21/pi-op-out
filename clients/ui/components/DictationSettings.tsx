import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Pencil, Plus, Save, Trash2 } from "lucide-solid";
import { useDictationConfiguration } from "../lib/dictation";
import { savedModelKey } from "../lib/clientPreferenceMerge";
import { isMobile } from "../lib/platform";
import type { AppSettings, DictationEngine, SavedDictationModel } from "../types";
import { IconButton } from "./IconButton";

const engines: Record<DictationEngine, { label: string; program: string }> = {
  "needle": { label: "Cactus Needle (Whistle)", program: "needle" },
  "transcribe.cpp": { label: "transcribe.cpp", program: "transcribe.cpp" },
};

const fileName = (path: string) => path.split("/").pop() || path;

/** The engine type of a model file: Cactus Needle reads .cact files and transcribe.cpp reads .gguf files. */
function engineKind(model: string): DictationEngine | undefined {
  const name = model.trim().toLowerCase();
  return name.endsWith(".cact") ? "needle" : name.endsWith(".gguf") ? "transcribe.cpp" : undefined;
}

/** Shows the status of the speech engine on this device in one line. */
function DictationStatus() {
  const configuration = useDictationConfiguration();
  const language = () => configuration().language || (configuration().detectLanguage ? "language detected automatically" : "model default language");

  return <div class="dictation-status">
    <Show when={!configuration().loading} fallback={<p role="status"><i class="dictation-dot" />Checking the speech engine…</p>}>
      <Show when={configuration().error} fallback={<Show when={configuration().enabled}>
        <p role="status"><i class="dictation-dot ready" />Ready · {configuration().engine ? engines[configuration().engine!].label + " · " : ""}{language()}</p>
        <Show when={configuration().languages?.length}><small>The model knows {configuration().languages?.join(", ")}. Choose one with --language.</small></Show>
      </Show>}>
        {(error) => <p role="alert" class="dictation-settings-error"><i class="dictation-dot failed" />{error()}</p>}
      </Show>
    </Show>
  </div>;
}

/** One setup in the list. Click it to use it. */
function Choice(props: { model: SavedDictationModel; active: boolean; saved: boolean; onUse: () => void; onEdit: () => void; onRemove?: () => void; onSave?: () => void }) {
  const kind = () => engineKind(props.model.path);
  const engine = () => isMobile ? "built into the app" : props.model.program || "found automatically";
  const details = () => [
    (kind() ? engines[kind()!].label : "Unknown engine") + (props.model.args ? " · " + props.model.args : "") + (props.saved ? "" : " · not saved"),
    "Engine: " + engine(),
  ];

  return <li class={props.active ? "dictation-choice active" : "dictation-choice"}>
    <button type="button" role="radio" aria-checked={props.active} onClick={() => props.onUse()}>
      <i class="dictation-radio" />
      <span><strong>{fileName(props.model.path)}</strong><For each={details()}>{line => <small>{line}</small>}</For><small>{props.model.path}</small></span>
    </button>
    <Show when={props.onSave}>{save => <IconButton type="button" label={"Save " + fileName(props.model.path)} onClick={() => save()()}><Save size={14} /></IconButton>}</Show>
    <IconButton type="button" label={"Edit " + fileName(props.model.path)} onClick={() => props.onEdit()}><Pencil size={14} /></IconButton>
    <Show when={props.onRemove}>{remove => <IconButton type="button" label={"Remove " + fileName(props.model.path)} onClick={() => remove()()}><Trash2 size={14} /></IconButton>}</Show>
  </li>;
}

/** The form that adds a setup or changes one. */
function ModelForm(props: { initial?: SavedDictationModel; programs: string[]; onSubmit: (model: SavedDictationModel) => void; onCancel: () => void }) {
  const programList = createUniqueId();
  const [path, setPath] = createSignal(props.initial?.path ?? "");
  const [program, setProgram] = createSignal(props.initial?.program ?? "");
  const [args, setArgs] = createSignal(props.initial?.args ?? "");
  const kind = () => engineKind(path());
  const submit = () => {
    if (!kind()) return;
    const model: SavedDictationModel = { path: path().trim() };
    if (!isMobile && program().trim()) model.program = program().trim();
    if (args().trim()) model.args = args().trim().split(/\s+/).join(" ");
    props.onSubmit(model);
  };
  const keys = (event: KeyboardEvent) => { if (event.key === "Enter") submit(); if (event.key === "Escape") props.onCancel(); };

  return <div class="dictation-form">
    <label><span>Model</span><input aria-label="Model file path" autofocus placeholder="/path/to/model.cact or .gguf" value={path()} onInput={event => setPath(event.currentTarget.value)} onKeyDown={keys} /></label>
    <Show when={!isMobile}>
      <label><span>Engine</span><input aria-label="Engine program path" list={programList} placeholder={"Find " + (kind() ? engines[kind()!].program : "the engine") + " automatically"} value={program()} onInput={event => setProgram(event.currentTarget.value)} onKeyDown={keys} /></label>
      <datalist id={programList}><For each={props.programs}>{item => <option value={item} />}</For></datalist>
    </Show>
    <label><span>Arguments</span><input aria-label="Engine arguments" placeholder="--language en" value={args()} onInput={event => setArgs(event.currentTarget.value)} onKeyDown={keys} /></label>
    <small class="dictation-add-hint">{!path().trim() ? "A .cact file uses Cactus Needle. A .gguf file uses transcribe.cpp." : kind() ? "Engine type: " + engines[kind()!].label : "Unknown model file. Use a .cact or a .gguf file."}</small>
    <div><button type="button" class="primary-button" disabled={!kind()} onClick={submit}>{props.initial ? "Save" : "Add"}</button><button type="button" class="dictation-link" onClick={() => props.onCancel()}>Cancel</button></div>
  </div>;
}

export function DictationSettings(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const saved = () => props.settings.dictationModels ?? [];
  const current = (): SavedDictationModel => {
    const model: SavedDictationModel = { path: props.settings.dictationModelPath?.trim() ?? "" };
    if (props.settings.dictationEnginePath?.trim()) model.program = props.settings.dictationEnginePath.trim();
    if (props.settings.dictationArgs?.trim()) model.args = props.settings.dictationArgs.trim();
    return model;
  };
  const currentKey = () => savedModelKey(current());
  const currentSaved = () => !current().path || saved().some(model => savedModelKey(model) === currentKey());
  const programs = () => [...new Set(saved().map(model => model.program).filter((item): item is string => !!item))];
  /** The form: "new" adds a setup; a key changes that saved setup. */
  const [editing, setEditing] = createSignal<string>();

  const use = (model: SavedDictationModel) => ({ dictationModelPath: model.path, dictationEnginePath: model.program ?? "", dictationArgs: model.args ?? "" });
  const without = (key: string) => saved().filter(model => savedModelKey(model) !== key);
  /** Adds or changes a setup and uses it. */
  const submit = (model: SavedDictationModel) => {
    const old = editing();
    const rest = without(savedModelKey(model)).filter(item => old === "new" || old === "current" || savedModelKey(item) !== old);
    props.onChange({ dictationModels: [...rest, model], ...use(model) });
    setEditing(undefined);
  };
  const editedModel = () => editing() === "current" ? current() : saved().find(model => savedModelKey(model) === editing());

  return <div class="dictation-settings">
    <section class="dictation-group">
      <h3>Models</h3>
      <ul class="dictation-choices" role="radiogroup" aria-label="Dictation model">
        <For each={saved()}>{model => <Choice model={model} saved active={savedModelKey(model) === currentKey()} onUse={() => props.onChange(use(model))} onEdit={() => setEditing(savedModelKey(model))}
          onRemove={() => props.onChange({ dictationModels: without(savedModelKey(model)), ...(savedModelKey(model) === currentKey() ? use({ path: "" }) : {}) })} />}</For>
        <Show when={!currentSaved()}><Choice model={current()} saved={false} active onUse={() => undefined} onEdit={() => setEditing("current")} onSave={() => props.onChange({ dictationModels: [...saved(), current()] })} /></Show>
      </ul>
      <Show when={!saved().length && currentSaved()}><p class="dictation-empty">No models yet.</p></Show>
      <Show when={editing()} keyed fallback={<button type="button" class="dictation-link" onClick={() => setEditing("new")}><Plus size={14} />Add model</button>}>
        {key => <ModelForm initial={key === "new" ? undefined : editedModel()} programs={programs()} onSubmit={submit} onCancel={() => setEditing(undefined)} />}
      </Show>
    </section>
    <DictationStatus />
  </div>;
}
