import { Show, type JSX } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { X } from "lucide-solid";
import type { SidepaneTab } from "../lib/sidepaneTabs";

/** The tab bar of the side pane: one tab per chat, a dot while its agent works, and a close button. */
export function SidepaneTabs(props: { tabs: SidepaneTab[]; selected?: string; error?: string; onSelect: (key: string) => void; onClose: (tab: SidepaneTab) => void; children: JSX.Element }) {
  const change = (event: KeyboardEvent) => {
    const index = props.tabs.findIndex(tab => tab.key === props.selected);
    const next = event.key === "Home" ? 0 : event.key === "End" ? props.tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % props.tabs.length : event.key === "ArrowLeft" ? (index + props.tabs.length - 1) % props.tabs.length : -1;
    const tab = props.tabs[next];

    if (!tab) return;
    event.preventDefault(); props.onSelect(tab.key); document.getElementById(`sidepane-tab-${tab.key}`)?.focus();
  };

  return <>
    <header class="plugin-pane-header">
      <div role="tablist" aria-label="Side chats" onKeyDown={change}><Key each={props.tabs} by={tab => tab.key}>{item => { const tab = () => item(); return <div class="plugin-tab" role="presentation">
        <button id={`sidepane-tab-${tab().key}`} role="tab" aria-controls="sidepane-panel" aria-selected={props.selected === tab().key} tabIndex={props.selected === tab().key ? 0 : -1} data-tooltip={tab().session.name} onClick={() => props.onSelect(tab().key)}>
          <Show when={tab().running}><span class="sidepane-dot" role="img" aria-label="Working" /></Show>{tab().label}
        </button>
        <button class="plugin-tab-remove" type="button" aria-label={`Close ${tab().label}`} tabIndex={props.selected === tab().key ? 0 : -1} onClick={() => props.onClose(tab())}><X size={13} /></button>
      </div>; }}</Key></div>
    </header>
    <Show when={props.error}><p class="plugin-error" role="alert">{props.error}</p></Show>
    <div class="plugin-panel" id="sidepane-panel" role="tabpanel" aria-labelledby={props.selected ? `sidepane-tab-${props.selected}` : undefined}>{props.children}</div>
  </>;
}
