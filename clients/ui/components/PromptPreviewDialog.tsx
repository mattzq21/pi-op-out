import { createSignal, createUniqueId, Index, onCleanup, Show, untrack } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";
import type { PromptPreview } from "../lib/hostAgents";
import { ContextCopyButton } from "./PromptContextBar";

const ROLE_NAMES: Record<string, string> = { system: "System", user: "User", assistant: "Assistant", toolResult: "Tool result" };

export function PromptPreviewDialog(props: { agent: string; build: () => Promise<PromptPreview>; onClose: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const titleId = createUniqueId();
  const [preview, setPreview] = createSignal<PromptPreview>();
  const [error, setError] = createSignal<string>();
  let open = true;
  onCleanup(() => { open = false; });
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();

    return () => { dialog?.close(); returnFocus?.focus(); };
  }, () => []);
  untrack(() => props.build()).then(value => { if (open) setPreview(value); }, reason => { if (open) setError(reason instanceof Error ? reason.message : String(reason)); });

  return <dialog ref={(element) => { dialogRef.current = element; }} class="extension-dialog prompt-preview-dialog" aria-labelledby={titleId} aria-busy={!preview() && !error()} onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <h2 id={titleId}>First prompt of “{props.agent}”</h2>
    <Show when={preview()} fallback={<Show when={error()} fallback={<p role="status">Building the prompt…</p>}>{message => <p class="dialog-error" role="alert">Could not build the prompt: {message()}</p>}</Show>}>{built => <>
      <p>Model: {built().model}. This is all that goes before the first user message.</p>
      <Index each={built().messages}>{message => <section class="prompt-preview-message">
        <header><strong>{ROLE_NAMES[message().role] ?? message().role}</strong><ContextCopyButton class="prompt-context-copy prompt-preview-copy" label={`Copy ${ROLE_NAMES[message().role] ?? message().role} text`} content={() => message().text} /></header>
        <pre>{message().text}</pre>
      </section>}</Index>
      <Show when={built().notices?.length}><p class="dialog-error" role="alert">The agent reported problems while it started:{"\n"}{built().notices!.join("\n")}</p></Show>
      <Index each={built().tools} fallback={<section class="prompt-preview-message"><header><strong>Tools</strong></header><p>The request has no tools.</p></section>}>{tools => <section class="prompt-preview-message">
        <header><strong>Tools in “{tools().place}”</strong><ContextCopyButton class="prompt-context-copy prompt-preview-copy" label={`Copy tools in ${tools().place}`} content={() => tools().json} /></header>
        <pre>{tools().json}</pre>
      </section>}</Index>
    </>}</Show>
    <div class="dialog-actions"><button autofocus onClick={() => props.onClose()}>Close</button></div>
  </dialog>;
}
