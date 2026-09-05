import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionUiRequest } from "../types";

export function ExtensionDialog({ request, owner, onRespond }: { request: ExtensionUiRequest; owner?: string; onRespond: (response: Record<string, unknown>) => void | Promise<void> }) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [responseError, setResponseError] = useState<string>();
  const [responding, setResponding] = useState(false);
  const respondingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const titleId = useId();
  useEffect(() => { setValue(request.prefill ?? ""); setResponseError(undefined); respondingRef.current = false; setResponding(false); }, [request.id, request.prefill]);
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); }; }, [request.id]);
  useEffect(() => () => { requestAnimationFrame(() => returnFocusRef.current?.focus()); }, []);
  const respond = async (response: Record<string, unknown>) => {
    if (respondingRef.current) return;
    respondingRef.current = true; setResponding(true); setResponseError(undefined);
    try { await onRespond(response); }
    catch (reason) { setResponseError(reason instanceof Error ? reason.message : String(reason)); }
    finally { respondingRef.current = false; setResponding(false); }
  };
  const cancel = () => { void respond({ cancelled: true }); };
  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!respondingRef.current) cancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (!responding && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) cancel(); }}>
      <p className="eyebrow">piop extension{owner ? ` · ${owner}` : ""}</p><h2 id={titleId}>{request.title || "Input requested"}</h2>{request.message && <p>{request.message}</p>}
      {request.method === "select" && <div className="dialog-options">{request.options?.map((option) => <button key={option} disabled={responding} onClick={() => void respond({ value: option })}>{option}</button>)}</div>}
      {(request.method === "input" || request.method === "editor") && (request.method === "editor" ? <textarea autoFocus rows={8} aria-label={request.placeholder || request.title} value={value} placeholder={request.placeholder} disabled={responding} onChange={(event) => setValue(event.target.value)} /> : <input autoFocus aria-label={request.placeholder || request.title} value={value} placeholder={request.placeholder} disabled={responding} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void respond({ value }); }} />)}
      {(responseError || request.error) && <p className="dialog-error" role="alert">{responseError || request.error}</p>}
      <div className="dialog-actions"><button disabled={responding} onClick={cancel}>Cancel</button>{request.method === "confirm" && <><button disabled={responding} onClick={() => void respond({ confirmed: false })}>No</button><button className="primary-button" disabled={responding} onClick={() => void respond({ confirmed: true })}>Confirm</button></>}{(request.method === "input" || request.method === "editor") && <button className="primary-button" disabled={responding} onClick={() => void respond({ value })}>Continue</button>}</div>
  </dialog>;
}
