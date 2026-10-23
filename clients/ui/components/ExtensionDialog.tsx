import { createSignal, createUniqueId, Index } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import type { ExtensionUiRequest, ExtensionUiResponse } from "../types";
import { stringsSchema } from "../lib/messageSchemas";

export function ExtensionDialog(componentProps: { request: ExtensionUiRequest; owner?: string; onRespond: (response: ExtensionUiResponse) => void | Promise<void> }) {
  const [value, setValue] = createSignal(componentProps.request.prefill ?? "");
  const [responseError, setResponseError] = createSignal<string>();
  const [responding, setResponding] = createSignal(false);
  const respondingRef = createRef(false);
  const dialogRef = createRef<HTMLDialogElement>(null);
  const returnFocusRef = createRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const titleId = createUniqueId();
  createDependencyEffect(() => {
    const capturedRequest0 = componentProps.request;
 setValue(capturedRequest0.prefill ?? ""); setResponseError(undefined); respondingRef.current = false; setResponding(false); }, () => [componentProps.request.id, componentProps.request.prefill]);
  createDependencyEffect(() => { const dialog = dialogRef.current; dialog?.showModal();

  return () => { if (dialog?.open) dialog.close(); }; }, () => [componentProps.request.id]);
  createDependencyEffect(() => () => { requestAnimationFrame(() => returnFocusRef.current?.focus()); }, () => []);

  const respond = async (response: ExtensionUiResponse) => { const capturedOnRespond0 = componentProps.onRespond;

    if (respondingRef.current) return;
    respondingRef.current = true; setResponding(true); setResponseError(undefined);

    try { await capturedOnRespond0(response); }
    catch (reason) { setResponseError(reason instanceof Error ? reason.message : String(reason)); }
    finally { respondingRef.current = false; setResponding(false); }
  };

  const cancel = () => { void respond({ cancelled: true }); };

  const renderDialogOptions = () => (componentProps.request.method === "select" && <div class="dialog-options">{<Index each={stringsSchema.catch([]).parse(componentProps.request.options)}>{(option, _index) => <button  disabled={responding()} onClick={() => void respond({ value: option() })}>{option()}</button>}</Index>}</div>);
  const renderTextInput = () => ((componentProps.request.method === "input" || componentProps.request.method === "editor") && (componentProps.request.method === "editor" ? <textarea autofocus rows={8} aria-label={componentProps.request.placeholder || componentProps.request.title} value={value()} placeholder={componentProps.request.placeholder} disabled={responding()} onInput={(event) => setValue(event.target.value)} /> : <input autofocus aria-label={componentProps.request.placeholder || componentProps.request.title} value={value()} placeholder={componentProps.request.placeholder} disabled={responding()} onInput={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) void respond({ value: value() }); }} />));
  const renderDialogError = () => ((responseError() || componentProps.request.error) && <p class="dialog-error" role="alert">{responseError() || componentProps.request.error}</p>);
  const renderDialogActions = () => (<div class="dialog-actions"><button disabled={responding()} onClick={cancel}>Cancel</button>{componentProps.request.method === "confirm" && <><button disabled={responding()} onClick={() => void respond({ confirmed: false })}>No</button><button class="primary-button" disabled={responding()} onClick={() => void respond({ confirmed: true })}>Confirm</button></>}{(componentProps.request.method === "input" || componentProps.request.method === "editor") && <button class="primary-button" disabled={responding()} onClick={() => void respond({ value: value() })}>Continue</button>}</div>);

  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault();

  if (!respondingRef.current) cancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect();

  if (!responding() && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) cancel(); }}>
    <h2 id={titleId}>{componentProps.request.title || "Input requested"}</h2>{componentProps.request.message && <p>{componentProps.request.message}</p>}
    {renderDialogOptions()}
    {renderTextInput()}
    {renderDialogError()}
    {renderDialogActions()}
  </dialog>;
}
