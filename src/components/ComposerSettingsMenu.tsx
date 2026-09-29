import { createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";

export function ComposerSettingsMenu(props: { agent: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  onMount(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });
  return <div class="composer-settings" ref={root} onKeyDown={event => {
    if (event.key === "Escape" && open()) {
      event.stopPropagation(); setOpen(false); trigger.focus();
    }
  }} onFocusOut={event => {
    if (event.relatedTarget && !root.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} type="button" class="composer-settings-trigger select-control"
      aria-label={`Chat settings: ${props.agent}`} aria-expanded={open()} aria-controls={id}
      onClick={() => setOpen(value => !value)}>{props.agent}</button>
    <div id={id} class="composer-settings-panel" data-open={open()} role="group" aria-label="Chat settings">{props.children}</div>
  </div>;
}
