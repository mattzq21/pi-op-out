import { createEffect, createSignal, on, onCleanup, Show, type Accessor } from "solid-js";
import { LoaderCircle } from "lucide-solid";

const SHOW_DELAY = 300;
const FADE = 150;

export type DelayedPresence = { shown: Accessor<boolean>; leaving: Accessor<boolean> };

export function createDelayedPresence(active: Accessor<boolean>): DelayedPresence {
  const [shown, setShown] = createSignal(false);

  createEffect(on(active, isActive => {
    const timer = isActive ? setTimeout(() => setShown(true), SHOW_DELAY) : shown() ? setTimeout(() => setShown(false), FADE) : undefined;
    onCleanup(() => clearTimeout(timer));
  }));

  return { shown, leaving: () => shown() && !active() };
}

export type PendingStatus = { text: string; label: string };

export function SendingStatus(props: { status?: PendingStatus; presence: DelayedPresence }) {
  const [shown, setShown] = createSignal<PendingStatus>({ text: "", label: "" });

  createEffect(() => { const status = props.status;

    if (status !== undefined) setShown(status); });

  return (<Show when={props.presence.shown()}><div class="sending-status" classList={{ leaving: props.presence.leaving() }} aria-label={props.presence.leaving() ? undefined : shown().label} aria-hidden={props.presence.leaving()} aria-busy="true"><LoaderCircle class="mcp-loading-spinner" size={13} aria-hidden="true" /><span role="status">{shown().text}</span></div></Show>);
}
