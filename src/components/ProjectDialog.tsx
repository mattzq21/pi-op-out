import { useEffect, useRef, useState } from "react";
import type { DirectoryListing, RemoteHost } from "../types";

interface Props {
  initialPath: string;
  hosts: RemoteHost[];
  initialHostId: string;
  onHomeDirectory: (hostId: string) => Promise<string>;
  onChooseDirectory: (currentPath: string, hostId: string) => Promise<string | DirectoryListing | null>;
  onOpen: (path: string, hostId: string) => Promise<void>;
  onCancel: () => void;
}

export function ProjectDialog({ initialPath, hosts, initialHostId, onHomeDirectory, onChooseDirectory, onOpen, onCancel }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel); onCancelRef.current = onCancel;
  const [path, setPath] = useState(initialPath);
  const [hostId, setHostId] = useState(initialHostId);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const backdrop = backdropRef.current; const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("input")?.focus();
    const siblings = backdrop?.parentElement ? Array.from(backdrop.parentElement.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop) : [];
    const siblingState = siblings.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    for (const element of siblings) { element.inert = true; element.setAttribute("aria-hidden", "true"); }
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => !element.hidden && element.getClientRects().length > 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onCancelRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(); const active = document.activeElement;
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && (active === first || !dialog?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !dialog?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    const frame = requestAnimationFrame(() => (dialog?.querySelector<HTMLElement>("input") ?? focusable()[0] ?? dialog)?.focus());
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener("keydown", handleKeyDown, true);
      for (const { element, inert, ariaHidden } of siblingState) { element.inert = inert; if (ariaHidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", ariaHidden); }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => { let cancelled = false; setChoosing(true); setError(undefined); void onHomeDirectory(hostId).then((home) => { if (!cancelled) setPath(home); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) setChoosing(false); }); return () => { cancelled = true; }; }, [hostId, onHomeDirectory]);
  const open = async () => { if (!path.trim()) { setError("Path can't be empty"); return; } setChoosing(true); setError(undefined); try { await onOpen(path, hostId); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setChoosing(false); } };
  const choose = async (directory = path) => {
    setChoosing(true); setError(undefined);
    try { const selected = await onChooseDirectory(directory, hostId); if (typeof selected === "string") setPath(selected); else if (selected) { setPath(selected.path); setListing(selected); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChoosing(false); }
  };
  return <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section ref={dialogRef} tabIndex={-1} className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <p className="eyebrow">Project</p><h2 id="project-dialog-title">Open project</h2><p>Open Pi in a project directory.</p>
      <label className="field"><span>Machine</span><select aria-label="Machine" value={hostId} onChange={(event) => { setHostId(event.target.value); setPath(""); setListing(undefined); setError(undefined); }}><option value="local">Local</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
      <input autoFocus aria-label="Project directory" value={path} placeholder="/path/to/project" onChange={(event) => { setPath(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") void open(); }} />
      {hostId !== "local" && listing && <div className="remote-directory-list" aria-label="Remote directories">{listing.parent && <button onClick={() => void choose(listing.parent)}>..</button>}{listing.directories.map((directory) => <button key={directory} onClick={() => void choose(directory)}>{directory.split("/").filter(Boolean).at(-1) || directory}</button>)}</div>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="browse-directory" disabled={choosing} onClick={() => void choose()}>{choosing ? "Working…" : "Choose directory…"}</button><button disabled={choosing} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={choosing} onClick={() => void open()}>Open project</button></div>
    </section>
  </div>;
}
