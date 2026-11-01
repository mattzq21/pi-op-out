import { Key } from "@solid-primitives/keyed";
import { ChevronDown } from "lucide-solid";
import { createMemo, createSignal, type JSXElement } from "solid-js";
import { createDependencyEffect } from "../lib/solid";

export type FilterOption = { value: string; label: string; search: string; disabled?: boolean; group?: number; italic?: boolean };

export function FilterSelect(props: { label: string; filterPlaceholder: string; value: string; options: FilterOption[]; invalid?: boolean; disabled?: boolean; onChange: (value: string) => void; trigger?: { content: JSXElement; class: string; tooltip?: string; alignEnd?: boolean } }) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(-1);
  let root: HTMLDivElement | undefined, trigger: HTMLButtonElement | undefined, filter: HTMLInputElement | undefined, list: HTMLDivElement | undefined;
  const visible = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();

    return text ? props.options.filter(option => option.search.toLocaleLowerCase().includes(text)) : props.options;
  });
  const selected = () => props.options.find(option => option.value === props.value);
  const close = (refocus: boolean) => { setOpen(false); setQuery(""); if (refocus) trigger?.focus(); };
  const show = () => {
    setOpen(true);
    setActive(visible().findIndex(option => option.value === props.value && !option.disabled));
    queueMicrotask(() => { filter?.focus(); list?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); });
  };
  const choose = (option: FilterOption | undefined) => { if (!option || option.disabled) return; props.onChange(option.value); close(true); };
  const move = (direction: 1 | -1) => {
    const options = visible();
    let next = active();

    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next].disabled) { setActive(next); list?.querySelectorAll('[role="option"]')[next]?.scrollIntoView?.({ block: "nearest" }); return; }
    }
  };

  createDependencyEffect(() => {
    if (!open()) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Node) || !root?.contains(event.target)) close(false); };

    document.addEventListener("pointerdown", dismiss);

    return () => document.removeEventListener("pointerdown", dismiss);
  }, () => [open()]);

  return <div ref={root} class={props.trigger?.alignEnd ? "filter-select filter-select-end" : "filter-select"} onFocusOut={event => { if (event.relatedTarget instanceof Node && !root?.contains(event.relatedTarget)) close(false); }}>
    {props.trigger
      ? <button ref={trigger} type="button" class={props.trigger.class} aria-haspopup="listbox" aria-expanded={open()} disabled={props.disabled} data-tooltip={props.trigger.tooltip} onClick={() => open() ? close(true) : show()}>{props.trigger.content}</button>
      : <button ref={trigger} type="button" class="filter-select-trigger" aria-label={props.label} aria-haspopup="listbox" aria-expanded={open()} aria-invalid={props.invalid} disabled={props.disabled} data-value={props.value} onClick={() => open() ? close(true) : show()}><span>{selected()?.label ?? props.value}</span><ChevronDown size={14} /></button>}
    {open() && <div class="filter-select-menu">
      <input ref={filter} aria-label={'Filter ' + props.label} placeholder={props.filterPlaceholder} value={query()} onInput={event => { setQuery(event.currentTarget.value); setActive(visible().findIndex(option => !option.disabled)); }} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
        else if (event.key === "Enter") { event.preventDefault(); choose(visible()[active()]); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      }} />
      <div ref={list} role="listbox" aria-label={props.label + ' options'}>{visible().length === 0 && <div class="empty-small">No matches</div>}<Key each={visible()} by={option => option.value}>{(option, index) => <>{index() > 0 && (visible()[index() - 1].group ?? 0) !== (option().group ?? 0) && <hr class="filter-select-divider" />}<button type="button" role="option" tabIndex={-1} aria-selected={option().value === props.value} data-active={index() === active() || undefined} data-value={option().value} data-italic={option().italic || undefined} disabled={option().disabled} onPointerMove={() => setActive(index())} onClick={() => choose(option())}>{option().label}</button></>}</Key></div>
    </div>}
  </div>;
}
