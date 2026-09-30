import { createMemo, createSelector, createSignal, createUniqueId, For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { ArrowDown, ArrowUp, Check, GitBranch, Search } from "lucide-solid";
import { createDependencyEffect } from "../lib/solid";

export function BranchPickerDialog(props: { branches: string[]; current: string | null; pending: boolean; error?: string; onSelect: (branch: string) => void; onCancel: () => void }) {
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;
  const id = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const isActive = createSelector(active);
  const results = createMemo(() => {
    const search = query().trim().toLowerCase();
    return props.branches.filter(branch => branch.toLowerCase().includes(search));
  });
  onMount(() => {
    const returnFocus = document.activeElement;
    dialog.showModal(); input.focus();
    onCleanup(() => { dialog.close(); if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus(); });
  });
  createDependencyEffect(() => { setActive(0); }, () => [results()]);
  createDependencyEffect(() => { document.getElementById(`${id}-branch-${active()}`)?.scrollIntoView({ block: "nearest" }); }, () => [active()]);
  const cancel = () => { if (!props.pending) props.onCancel(); };
  const choose = (branch: string) => { if (!props.pending) props.onSelect(branch); };
  const navigate = (event: KeyboardEvent) => {
    if (event.isComposing || props.pending) return;
    if (event.key === "Enter") { event.preventDefault(); const branch = results()[active()]; if (branch) choose(branch); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); const count = results().length;
      setActive((index) => count ? (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count : 0);
    }
  };
  return <Portal mount={document.querySelector(".app") ?? document.body}><dialog ref={dialog} class="extension-dialog directory-palette" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); cancel(); }} onMouseDown={(event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel();
  }}>
    <header class="directory-palette-heading"><h2 id={`${id}-title`}>Choose a branch</h2><button type="button" class="directory-palette-escape" disabled={props.pending} onClick={cancel}>esc</button></header>
    <div class="directory-palette-search"><Search size={20} /><input ref={input} role="combobox" aria-label="Search branches" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={results().length ? `${id}-branch-${active()}` : undefined} autocomplete="off" spellcheck={false} placeholder="Search branches…" value={query()} disabled={props.pending} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={navigate} /></div>
    <div class="directory-palette-caption"><span>{props.pending ? "Opening branch…" : `${results().length} branches`}</span><span>Enter to select</span></div>
    <div id={`${id}-results`} class="directory-palette-results" role="listbox" aria-label="Branches" aria-busy={props.pending}>
      <For each={results()}>{(branch, index) => <div id={`${id}-branch-${index()}`} class="directory-palette-result" role="option" aria-selected={isActive(index())} aria-disabled={props.pending} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index())} onClick={() => choose(branch)}><GitBranch size={17} /><span>{branch}</span>{branch === props.current && <small><Check size={13} />Current</small>}</div>}</For>
      {!results().length && <div class="directory-palette-empty">No matching branches.</div>}
    </div>
    {props.error && <p class="dialog-error" role="alert">{props.error}</p>}
    <footer class="directory-palette-hints"><span><ArrowUp size={12} /><ArrowDown size={12} /> navigate</span><span>Enter select</span><span>Esc close</span></footer>
  </dialog></Portal>;
}
