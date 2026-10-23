import { createEffect, createSignal, createUniqueId, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export function ContextTokenDiagram(props: { tokens: number; style: JSX.CSSProperties }) {
  const [position, setPosition] = createSignal<{ top: number; right: number }>();
  const id = createUniqueId();
  let button!: HTMLButtonElement;
  const label = () => `${props.tokens.toLocaleString()} tokens`;
  const close = () => setPosition(undefined);

  const toggle = () => {
    if (position()) return close();
    const rect = button.getBoundingClientRect();
    setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 40)), right: Math.max(8, window.innerWidth - rect.right) });
  };

  createEffect(() => {
    if (!position()) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Node) || !button.contains(event.target)) close(); };

    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    });
  });

  return <>
    <button ref={button} type="button" class="prompt-context-diagram" data-tooltip={label()} aria-label={label()}
      aria-describedby={position() ? id : undefined} onClick={toggle} onBlur={close}
      onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <span class="prompt-context-wheel" style={props.style} aria-hidden="true" />
    </button>
    <Show when={position()}>{point => <Portal><span id={id} role="tooltip" class="prompt-context-token-tooltip"
      style={{ top: `${point().top}px`, right: `${point().right}px` }}>{label()}</span></Portal>}</Show>
  </>;
}
