import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Pencil, Plus, Settings2, Trash2 } from "lucide-solid";
import { useDictationConfiguration } from "../lib/dictation";
import { invoke, isMobile } from "../lib/platform";
import { dictationFoundEnginesSchema } from "../lib/responseSchemas";
import type { AppSettings, DictationEngine, DictationEngineSettings, DictationModelEntry } from "../types";
import { IconButton } from "./IconButton";

const engines: Record<DictationEngine, { label: string; program: string; extension: string }> = {
  "transcribe.cpp": { label: "transcribe.cpp", program: "python3 with transcribe.cpp", extension: ".gguf" },
  "needle": { label: "Needle", program: "needle", extension: ".cact" },
};
const engineTypes = Object.keys(engines) as DictationEngine[];

const fileName = (path: string) => path.split("/").pop() || path;
const modelName = (model: DictationModelEntry) => model.name || fileName(model.path);
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
      <span><strong>{modelName(props.model)}<Show when={props.model.args}>{args => <code>{args()}</code>}</Show></strong><small>{props.model.path}</small></span>
    </button>
    <IconButton type="button" label={"Edit " + modelName(props.model)} onClick={() => props.onEdit()}><Pencil size={14} /></IconButton>
    <IconButton type="button" label={"Remove " + modelName(props.model)} onClick={() => props.onRemove()}><Trash2 size={14} /></IconButton>
  </li>;
}

/** The form that adds a model to the engine or changes one. */
function ModelForm(props: { engine: DictationEngine; initial?: DictationModelEntry; onSubmit: (model: DictationModelEntry) => void; onCancel: () => void }) {
  const [name, setName] = createSignal(props.initial?.name ?? "");
  const [path, setPath] = createSignal(props.initial?.path ?? "");
  const [args, setArgs] = createSignal(props.initial?.args ?? "");
  const extension = () => engines[props.engine].extension;
  const valid = () => path().trim().toLowerCase().endsWith(extension());
  const submit = () => {
    if (!valid()) return;
    const model: DictationModelEntry = { ...(name().trim() ? { name: name().trim() } : {}), path: path().trim() };
    if (args().trim()) model.args = args().trim().split(/\s+/).join(" ");
    props.onSubmit(model);
  };
  const keys = (event: KeyboardEvent) => { if (event.key === "Enter") submit(); if (event.key === "Escape") props.onCancel(); };

  return <div class="dictation-form">
    <label><span>Name</span><input aria-label="Model name" autofocus placeholder={path().trim() ? fileName(path().trim()) : "Optional"} value={name()} onInput={event => setName(event.currentTarget.value)} onKeyDown={keys} /></label>
    <label><span>Model</span><input aria-label="Model file path" placeholder={"/path/to/model" + extension()} value={path()} onInput={event => setPath(event.currentTarget.value)} onKeyDown={keys} /></label>
    <label><span>Arguments</span><input aria-label="Engine arguments" placeholder="--language en" value={args()} onInput={event => setArgs(event.currentTarget.value)} onKeyDown={keys} /></label>
    <Show when={path().trim() && !valid()}><small class="dictation-add-hint">{engines[props.engine].label} needs a {extension()} file.</small></Show>
    <div><button type="button" class="primary-button" disabled={!valid()} onClick={submit}>{props.initial ? "Save" : "Add"}</button><button type="button" class="dictation-link" onClick={() => props.onCancel()}>Cancel</button></div>
  </div>;
}

/** One saved engine. Click it to use it. It says "Not found" only when Piop cannot find the program. The settings button shows its path and where Piop found it. */
function EngineTile(props: { entry: DictationEngineSettings; found?: Found; active: boolean; onUse: () => void; onPath: (path: string) => void; onRemove: () => void }) {
  const [open, setOpen] = createSignal(false);
  const label = () => engines[props.entry.engine].label;
  const missing = () => !isMobile && props.found !== undefined && !props.found.executable;

  return <li class="dictation-engine" classList={{ active: props.active, open: open() }}>
    <button type="button" class="dictation-engine-pick" role="radio" aria-checked={props.active} onClick={() => props.onUse()}>
      <i class="dictation-radio" />
      <span><strong>{label()}</strong><Show when={missing()}><small><i class="dictation-dot failed" />Not found</small></Show></span>
    </button>
    <span class="dictation-engine-tools">
      <Show when={!isMobile}><IconButton type="button" label={label() + " settings"} aria-expanded={open()} onClick={() => setOpen(value => !value)}><Settings2 size={14} /></IconButton></Show>
      <IconButton type="button" label={"Remove " + label()} onClick={() => props.onRemove()}><Trash2 size={14} /></IconButton>
    </span>
    <Show when={open()}>
      <div class="dictation-engine-settings">
        <label><span>Engine path</span><input aria-label={label() + " path"} placeholder={"Search PATH for " + engines[props.entry.engine].program} value={props.entry.path ?? ""} onChange={event => props.onPath(event.currentTarget.value)} /></label>
        <p class="dictation-found" role="status">
          <Show when={props.found} fallback={<>Searching…</>}>
            {found => <Show when={found().executable} fallback={<span class="dictation-settings-error">{found().error}</span>}>{executable => <>Program: <code>{executable()}</code></>}</Show>}
          </Show>
        </p>
      </div>
    </Show>
  </li>;
}

export function DictationSettings(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const entries = () => props.settings.dictationEngines ?? [];
  const entry = (type: DictationEngine): DictationEngineSettings => entries().find(item => item.engine === type) ?? { engine: type, models: [] };
  /** The engine in use. Only a saved engine can be in use. */
  const engine = (): DictationEngine | undefined => entries().some(item => item.engine === props.settings.dictationEngine) ? props.settings.dictationEngine : undefined;
  const models = () => engine() ? entry(engine()!).models : [];
  const current = (): DictationModelEntry => ({ path: props.settings.dictationModelPath?.trim() ?? "", args: props.settings.dictationArgs?.trim() || undefined });
  const unsaved = () => engineTypes.filter(type => !entries().some(item => item.engine === type));
  /** The model form: "new" adds a model; a number changes that model. */
  const [editing, setEditing] = createSignal<"new" | number>();
  const [adding, setAdding] = createSignal(false);
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
  const chooseEngine = (type: DictationEngine) => { if (type === engine()) return; setEditing(undefined); props.onChange({ dictationEngine: type, ...use(entry(type).models[0]) }); };
  const addEngine = (type: DictationEngine) => { setAdding(false); setEditing(undefined); props.onChange({ dictationEngines: updateEntry(type, {}), dictationEngine: type, ...use() }); };
  const removeEngine = (type: DictationEngine) => {
    const rest = entries().filter(item => item.engine !== type);
    const next = type === engine() ? rest[0] : undefined;
    if (type === engine()) setEditing(undefined);
    props.onChange({ dictationEngines: rest, ...(type === engine() ? { dictationEngine: next?.engine, ...use(next?.models[0]) } : {}) });
  };
  const submit = (model: DictationModelEntry) => {
    const type = engine();
    if (!type) return;
    const old = editing();
    const list = models().filter((item, index) => index !== old && !sameModel(item, model));
    const position = typeof old === "number" ? Math.min(old, list.length) : list.length;
    list.splice(position, 0, model);
    props.onChange({ dictationEngines: updateEntry(type, { models: list }), ...use(model) });
    setEditing(undefined);
  };
  const remove = (index: number) => {
    const type = engine();
    if (!type) return;
    const model = models()[index];
    const list = models().filter((_, position) => position !== index);
    props.onChange({ dictationEngines: updateEntry(type, { models: list }), ...(sameModel(model, current()) ? use(list[0]) : {}) });
    setEditing(undefined);
  };

  return <div class="dictation-settings">
    <section class="dictation-group">
      <h3>Engines</h3>
      <ul class="dictation-engines" role="radiogroup" aria-label="Dictation engine">
        <For each={entries().map(item => item.engine)}>{type => <EngineTile entry={entry(type)} found={found()[type]} active={type === engine()} onUse={() => chooseEngine(type)}
          onPath={path => props.onChange({ dictationEngines: updateEntry(type, { path }) })} onRemove={() => removeEngine(type)} />}</For>
        <Show when={unsaved().length}>
          <li class="dictation-engine-add">
            <Show when={adding()} fallback={<button type="button" class="dictation-engine-add-button" onClick={() => setAdding(true)}><Plus size={14} />Add engine</button>}>
              <div class="dictation-add-engine">
                <For each={unsaved()}>{type => <button type="button" class="dictation-engine-option" onClick={() => addEngine(type)}><Plus size={13} />{engines[type].label}</button>}</For>
                <button type="button" class="dictation-link" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </Show>
          </li>
        </Show>
      </ul>
    </section>
    <Show when={engine()} keyed>{type => <section class="dictation-group">
      <h3>{engines[type].label} models</h3>
      <Show when={models().length} fallback={<p class="dictation-empty">No models yet.</p>}>
        <ul class="dictation-choices" role="radiogroup" aria-label="Dictation model">
          <For each={models()}>{(model, index) => <Choice model={model} active={sameModel(model, current())} onUse={() => props.onChange(use(model))} onEdit={() => setEditing(index())} onRemove={() => remove(index())} />}</For>
        </ul>
      </Show>
      <Show when={editing()} keyed fallback={<button type="button" class="dictation-link" onClick={() => setEditing("new")}><Plus size={14} />Add model</button>}>
        {key => <ModelForm engine={type} initial={key === "new" ? undefined : models()[key]} onSubmit={submit} onCancel={() => setEditing(undefined)} />}
      </Show>
    </section>}</Show>
    <DictationStatus />
  </div>;
}
