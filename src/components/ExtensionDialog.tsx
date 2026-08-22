import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "../types";

export function ExtensionDialog({ request, onRespond }: { request: ExtensionUiRequest; onRespond: (response: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(request.prefill ?? "");
  useEffect(() => { setValue(request.prefill ?? ""); }, [request.id, request.prefill]);
  const cancel = () => onRespond({ cancelled: true });
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <section className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
      <p className="eyebrow">Pi extension</p><h2 id="extension-dialog-title">{request.title || "Input requested"}</h2>{request.message && <p>{request.message}</p>}
      {request.method === "select" && <div className="dialog-options">{request.options?.map((option) => <button key={option} onClick={() => onRespond({ value: option })}>{option}</button>)}</div>}
      {(request.method === "input" || request.method === "editor") && (request.method === "editor" ? <textarea autoFocus rows={8} aria-label={request.placeholder || request.title} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} /> : <input autoFocus aria-label={request.placeholder || request.title} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onRespond({ value }); }} />)}
      {request.error && <p className="dialog-error" role="alert">{request.error}</p>}
      <div className="dialog-actions"><button onClick={cancel}>Cancel</button>{request.method === "confirm" && <><button onClick={() => onRespond({ confirmed: false })}>No</button><button className="primary-button" onClick={() => onRespond({ confirmed: true })}>Confirm</button></>}{(request.method === "input" || request.method === "editor") && <button className="primary-button" onClick={() => onRespond({ value })}>Continue</button>}</div>
    </section>
  </div>;
}
