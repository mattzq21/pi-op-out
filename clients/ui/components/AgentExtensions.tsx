import { createSignal, Index, Show } from "solid-js";
import { Plus, Puzzle, X } from "lucide-solid";
import { IconButton } from "./IconButton";

/** The piop extension paths of an agent: one editable row per path, and a row to add one. */
export function AgentExtensions(props: { paths: string[]; onChange: (paths: string[]) => void }) {
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string>();

  const add = () => {
    const path = draft().trim();

    if (!path) return;

    if (props.paths.includes(path)) { setError(`${path} is already added.`); return; }
    props.onChange([...props.paths, path]);
    setDraft(""); setError(undefined);
  };

  const edit = (index: number, input: HTMLInputElement) => {
    const path = input.value.trim();

    if (props.paths.some((item, other) => other !== index && item === path)) { input.value = props.paths[index]!; setError(`${path} is already added.`); return; }
    setError(undefined);
    props.onChange(path ? props.paths.map((item, other) => other === index ? path : item) : props.paths.filter((_, other) => other !== index));
  };

  return <fieldset class="agent-extensions">
    <legend>Extensions</legend>
    <Index each={props.paths}>{(path, index) => <div class="agent-extension">
      <Puzzle size={13} aria-hidden="true" />
      <input aria-label={`Extension ${index + 1}`} spellcheck={false} value={path()} onChange={event => edit(index, event.currentTarget)} />
      <IconButton label={`Remove ${path()}`} onClick={() => props.onChange(props.paths.filter((_, other) => other !== index))}><X size={14} /></IconButton>
    </div>}</Index>
    <div class="agent-extension agent-extension-add">
      <Plus size={13} aria-hidden="true" />
      <input aria-label="New extension path" spellcheck={false} placeholder="/path/to/extension.ts" value={draft()} onInput={event => { setDraft(event.currentTarget.value); setError(undefined); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      <button type="button" class="secondary-button" disabled={!draft().trim()} onClick={add}>Add</button>
    </div>
    <Show when={error()}>{message => <small class="mcp-error" role="alert">{message()}</small>}</Show>
  </fieldset>;
}
