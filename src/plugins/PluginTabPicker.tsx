import { For, onCleanup, onMount } from "solid-js";
import { Plus } from "lucide-solid";

export function PluginTabPicker(props: { items: { id: string; name: string }[]; onSelect: (id: string) => void }) {
  let picker: HTMLDetailsElement | undefined;
  const close = () => picker?.removeAttribute("open");
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (picker && !event.composedPath().includes(picker)) close(); };

    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });

  return <details class="plugin-tab-picker" ref={picker} onKeyDown={event => { if (event.key === "Escape") { close(); picker?.querySelector("summary")?.focus(); } }}
    onFocusOut={event => { if (!(event.relatedTarget instanceof Node && picker?.contains(event.relatedTarget))) close(); }}>
    <summary class="icon-button" aria-label="Add tab" data-tooltip="Add tab"><Plus size={18} /></summary>
    <div class="plugin-tab-options"><For each={props.items}>{item => <button type="button" onClick={() => { close(); props.onSelect(item.id); }}>{item.name}</button>}</For></div>
  </details>;
}
