import { Check } from "lucide-solid";
import { createSignal, For, onCleanup, Show, type JSXElement } from "solid-js";
import { Portal } from "solid-js/web";
import { debugFeatures, type DebugFeature } from "../lib/debugFeatures";
import { IconButton } from "./IconButton";

/** The debug mode button. A right click opens a menu that turns each debug feature on or off. */
export function DebugModeButton(props: { debugMode: boolean; featuresOff: readonly string[]; disabled: boolean; onToggle: () => void; onToggleFeature: (feature: DebugFeature) => void; children: JSXElement }) {
  const [menu, setMenu] = createSignal<{ x: number; y: number }>();
  let menuElement: HTMLDivElement | undefined;
  const close = () => setMenu(undefined);
  const outside = (event: PointerEvent) => { if (menuElement && event.target instanceof Node && !menuElement.contains(event.target)) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape);
  onCleanup(() => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); });

  return <>
    <IconButton label={props.debugMode ? "Disable debug mode" : "Enable debug mode"} class={props.debugMode ? "active" : ""} disabled={props.disabled} onClick={props.onToggle} onContextMenu={(event) => { event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); setMenu({ x: event.clientX || bounds.left, y: event.clientY || bounds.bottom }); }}>{props.children}</IconButton>
    <Show when={menu()}>{position => <Portal mount={document.querySelector(".app") ?? document.body}>
      <div ref={menuElement} class="conversation-menu link-context-menu debug-features-menu" role="menu" aria-label="Debug features" style={{ left: `${position().x}px`, top: `${position().y}px` }} onContextMenu={event => event.preventDefault()}>
        <For each={debugFeatures}>{feature => {
          const on = () => !props.featuresOff.includes(feature.id);
          return <button type="button" role="menuitemcheckbox" aria-checked={on()} disabled={props.disabled} onClick={() => props.onToggleFeature(feature.id)}><span class="debug-feature-check">{on() && <Check size={14} />}</span>{feature.label}</button>;
        }}</For>
      </div>
    </Portal>}</Show>
  </>;
}

