import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Pencil, Plus, Trash2 } from "lucide-solid";
import { useDictationConfiguration } from "../lib/dictation";
import { invoke, isMobile } from "../lib/platform";
import { dictationFoundEnginesSchema } from "../lib/responseSchemas";
import type { AppSettings, DictationEngine, DictationEngineSettings, DictationModelEntry } from "../types";
import { IconButton } from "./IconButton";

const engines: Record<DictationEngine, { label: string; program: string; extension: string }> = {
  "transcribe.cpp": { label: "transcribe.cpp", program: "python3 with transcribe.cpp", extension: ".gguf" },
  "needle": { label: "Cactus Needle (Whistle)", program: "needle", extension: ".cact" },
};
const engineTypes = Object.keys(engines) as DictationEngine[];

const fileName = (path: string) => path.split("/").pop() || path;
const sameModel = (a: DictationModelEntry, b: DictationModelEntry) => a.path === b.path && (a.args ?? "") === (b.args ?? "");

/** The search result for an engine: undefined while the search runs. */
type Found = { executable?: string; error?: string };

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

/** One model of the engine. Click it to use it. */
function Choice(props: { model: DictationModelEntry; active: boolean; onUse: () => void; onEdit: () => void; onRemove: () => void }) {
  return <li class={props.active ? "dictation-choice active" : "dictation-choice"}>
    <button type="button" role="radio" aria-checked={props.active} onClick={() => props.onUse()}>
      <i class="dictation-radio" />
      <span><strong>{fileName(props.model.path)}<Show when={props.model.args}>{args => <code>{args()}</code>}</Show></strong><small>{props.model.path}</small></span>
    </button>
    <IconButton type="button" label={"Edit " + fileName(props.model.path)} onClick={() => props.onEdit()}><Pencil size={14} /></IconButton>
    <IconButton type="button" label={"Remove " + fileName(props.model.path)} onClick={() => props.onRemove()}><Trash2 size={14} /></IconButton>
  </li>;
}

/** The form that adds a model to the engine or changes one. */
function ModelForm(props: { engine: DictationEngine; initial?: DictationModelEntry; onSubmit: (model: DictationModelEntry) => void; onCancel: () => void }) {
  const [path, setPath] = createSignal(props.initial?.path ?? "");
  const [args, setArgs] = createSignal(props.initial?.args ?? "");
  const extension = () => engines[props.engine].extension;
  const valid = () => path().trim().toLowerCase().endsWith(extension());
  const submit = () => {
    if (!valid()) return;
    const model: DictationModelEntry = { path: path().trim() };
    if (args().trim()) model.args = args().trim().split(/\s+/).join(" ");
    props.onSubmit(model);
  };
  const keys = (event: KeyboardEvent) => { if (event.key === "Enter") submit(); if (event.key === "Escape") props.onCancel(); };

  return <div class="dictation-form">
    <label><span>Model</span><input aria-label="Model file path" autofocus placeholder={"/path/to/model" + extension()} value={path()} onInput={event => setPath(event.currentTarget.value)} onKeyDown={keys} /></label>
    <label><span>Arguments</span><input aria-label="Engine arguments" placeholder="--language en" value={args()} onInput={event => setArgs(event.currentTarget.value)} onKeyDown={keys} /></label>
    <Show when={path().trim() && !valid()}><small class="dictation-add-hint">{engines[props.engine].label} needs a {extension()} file.</small></Show>
    <div><button type="button" class="primary-button" disabled={!valid()} onClick={submit}>{props.initial ? "Save" : "Add"}</button><button type="button" class="dictation-link" onClick={() => props.onCancel()}>Cancel</button></div>
  </div>;
}

/** Shows whether Piop found the engine program. */
function EngineFound(props: { found?: Found; configured: boolean }) {
  return <p class="dictation-found" role="status">
    <Show when={!isMobile} fallback={<><i class="dictation-dot ready" />Built into the app</>}>
      <Show when={props.found} fallback={<><i class="dictation-dot" />Searching…</>}>
        {found => <Show when={found().executable} fallback={<><i class="dictation-dot failed" /><span class="dictation-settings-error">{found().error}</span></>}>
          {executable => <><i class="dictation-dot ready" />Found{props.configured ? "" : " automatically"}: <code>{executable()}</code></>}
        </Show>}
      </Show>
    </Show>
  </p>;
}

export function DictationSettings(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const engine = (): DictationEngine => props.settings.dictationEngine ?? "transcribe.cpp";
  const entries = () => props.settings.dictationEngines ?? [];
  const entry = (type: DictationEngine): DictationEngineSettings => entries().find(item => item.engine === type) ?? { engine: type, models: [] };
  const models = () => entry(engine()).models;
  const current = (): DictationModelEntry => ({ path: props.settings.dictationModelPath?.trim() ?? "", args: props.settings.dictationArgs?.trim() || undefined });
  /** The model form: "new" adds a model; a number changes that model. */
  const [editing, setEditing] = createSignal<"new" | number>();
  const [found, setFound] = createSignal<Partial<Record<DictationEngine, Found>>>({});

  /** Searches for the engines each time this section opens and each time an engine path changes. */
  if (!isMobile) {
    let search = 0;
    createEffect(on(() => JSON.stringify(engineTypes.map(type => entry(type).path ?? "")), () => {
      const id = ++search;
      const paths = Object.fromEntries(engineTypes.map(type => [type, entry(type).path ?? ""]));
      setFound({});
      invoke("dictation_find_engines", { paths }, dictationFoundEnginesSchema)
        .then(result => { if (id === search) setFound(result); })
        .catch(reason => { if (id === search) setFound(Object.fromEntries(engineTypes.map(type => [type, { error: "Could not search for the engine: " + (reason instanceof Error ? reason.message : String(reason)) }]))); });
    }));
    onCleanup(() => { search++; });
  }

  const updateEntry = (type: DictationEngine, change: Partial<DictationEngineSettings>) => {
    const next = { ...entry(type), ...change };
    const value: DictationEngineSettings = { engine: type, ...(next.path?.trim() ? { path: next.path.trim() } : {}), models: next.models };
    const rest = entries().filter(item => item.engine !== type);
    return [...rest, value].sort((a, b) => engineTypes.indexOf(a.engine) - engineTypes.indexOf(b.engine));
  };
  const use = (model?: DictationModelEntry) => ({ dictationModelPath: model?.path ?? "", dictationArgs: model?.args ?? "" });
  const chooseEngine = (type: DictationEngine) => { setEditing(undefined); props.onChange({ dictationEngine: type, ...use(entry(type).models[0]) }); };
  const submit = (model: DictationModelEntry) => {
    const old = editing();
    const list = models().filter((item, index) => index !== old && !sameModel(item, model));
    const position = typeof old === "number" ? Math.min(old, list.length) : list.length;
    list.splice(position, 0, model);
    props.onChange({ dictationEngine: engine(), dictationEngines: updateEntry(engine(), { models: list }), ...use(model) });
    setEditing(undefined);
  };
  const remove = (index: number) => {
    const model = models()[index];
    const list = models().filter((_, position) => position !== index);
    props.onChange({ dictationEngines: updateEntry(engine(), { models: list }), ...(sameModel(model, current()) ? use(list[0]) : {}) });
    setEditing(undefined);
  };

  return <div class="dictation-settings">
    <section class="dictation-group">
      <label class="field dictation-field"><span>Engine</span>
        <select aria-label="Dictation engine" value={engine()} onChange={event => chooseEngine(event.currentTarget.value as DictationEngine)}>
          <For each={engineTypes}>{type => <option value={type}>{engines[type].label}</option>}</For>
        </select>
      </label>
      <Show when={!isMobile}>
        <label class="field dictation-field"><span>Engine path</span>
          <input aria-label="Engine path" placeholder={"Search PATH for " + engines[engine()].program} value={entry(engine()).path ?? ""} onChange={event => props.onChange({ dictationEngines: updateEntry(engine(), { path: event.currentTarget.value }) })} />
        </label>
      </Show>
      <EngineFound found={found()[engine()]} configured={!!entry(engine()).path} />
    </section>
    <section class="dictation-group">
      <h3>Models</h3>
      <Show when={models().length} fallback={<p class="dictation-empty">No models for {engines[engine()].label} yet.</p>}>
        <ul class="dictation-choices" role="radiogroup" aria-label="Dictation model">
          <For each={models()}>{(model, index) => <Choice model={model} active={sameModel(model, current())} onUse={() => props.onChange(use(model))} onEdit={() => setEditing(index())} onRemove={() => remove(index())} />}</For>
        </ul>
      </Show>
      <Show when={editing() !== undefined ? { key: editing()!, engine: engine() } : undefined} keyed fallback={<button type="button" class="dictation-link" onClick={() => setEditing("new")}><Plus size={14} />Add model</button>}>
        {state => <ModelForm engine={state.engine} initial={state.key === "new" ? undefined : models()[state.key]} onSubmit={submit} onCancel={() => setEditing(undefined)} />}
      </Show>
    </section>
    <DictationStatus />
  </div>;
}
