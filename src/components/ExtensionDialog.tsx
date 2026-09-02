import { useEffect, useRef, useState } from "react";
import type { ExtensionUiRequest } from "../types";
import { useModalFocus } from "../lib/modalFocus";

export function ExtensionDialog({ request, onRespond }: { request: ExtensionUiRequest; onRespond: (response: Record<string, unknown>) => void | Promise<void> }) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [responseError, setResponseError] = useState<string>();
  const [responding, setResponding] = useState(false);
  const respondingRef = useRef(false);
  useEffect(() => { setValue(request.prefill ?? ""); setResponseError(undefined); respondingRef.current = false; setResponding(false); }, [request.id, request.prefill]);
  const respond = async (response: Record<string, unknown>) => {
    if (respondingRef.current) return;
    respondingRef.current = true; setResponding(true); setResponseError(undefined);
    try { await onRespond(response); }
    catch (reason) { setResponseError(reason instanceof Error ? reason.message : String(reason)); }
    finally { respondingRef.current = false; setResponding(false); }
  };
  const cancel = () => { void respond({ cancelled: true }); };
  const modal = useModalFocus(cancel, request.id);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!responding && event.target === event.currentTarget) cancel(); }}>
    <section ref={modal} className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
      <p className="eyebrow">Pi extension</p><h2 id="extension-dialog-title">{request.title || "Input requested"}</h2>{request.message && <p>{request.message}</p>}
      {request.method === "select" && <div className="dialog-options">{request.options?.map((option) => <button key={option} disabled={responding} onClick={() => void respond({ value: option })}>{option}</button>)}</div>}
      {(request.method === "input" || request.method === "editor") && (request.method === "editor" ? <textarea autoFocus rows={8} aria-label={request.placeholder || request.title} value={value} placeholder={request.placeholder} disabled={responding} onChange={(event) => setValue(event.target.value)} /> : <input autoFocus aria-label={request.placeholder || request.title} value={value} placeholder={request.placeholder} disabled={responding} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void respond({ value }); }} />)}
      {(responseError || request.error) && <p className="dialog-error" role="alert">{responseError || request.error}</p>}
      <div className="dialog-actions"><button disabled={responding} onClick={cancel}>Cancel</button>{request.method === "confirm" && <><button disabled={responding} onClick={() => void respond({ confirmed: false })}>No</button><button className="primary-button" disabled={responding} onClick={() => void respond({ confirmed: true })}>Confirm</button></>}{(request.method === "input" || request.method === "editor") && <button className="primary-button" disabled={responding} onClick={() => void respond({ value })}>Continue</button>}</div>
    </section>
  </div>;
}
