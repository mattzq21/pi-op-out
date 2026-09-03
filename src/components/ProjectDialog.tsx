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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [path, setPath] = useState(initialPath);
  const [hostId, setHostId] = useState(initialHostId);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); }; }, []);
  useEffect(() => { let cancelled = false; setChoosing(true); setError(undefined); void onHomeDirectory(hostId).then((home) => { if (!cancelled) setPath(home); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) setChoosing(false); }); return () => { cancelled = true; }; }, [hostId, onHomeDirectory]);
  const open = async () => { if (!path.trim()) { setError("Path can't be empty"); return; } setChoosing(true); setError(undefined); try { await onOpen(path, hostId); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setChoosing(false); } };
  const choose = async (directory = path) => {
    setChoosing(true); setError(undefined);
    try { const selected = await onChooseDirectory(directory, hostId); if (typeof selected === "string") setPath(selected); else if (selected) { setPath(selected.path); setListing(selected); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChoosing(false); }
  };
  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); onCancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onCancel(); }}>
      <p className="eyebrow">Project</p><h2 id="project-dialog-title">Open project</h2><p>Open Pi in a project directory.</p>
      <label className="field"><span>Machine</span><select aria-label="Machine" value={hostId} onChange={(event) => { setHostId(event.target.value); setPath(""); setListing(undefined); setError(undefined); }}><option value="local">Local</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
      <input autoFocus aria-label="Project directory" value={path} placeholder="/path/to/project" onChange={(event) => { setPath(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") void open(); }} />
      {hostId !== "local" && listing && <div className="remote-directory-list" aria-label="Remote directories">{listing.parent && <button onClick={() => void choose(listing.parent)}>..</button>}{listing.directories.map((directory) => <button key={directory} onClick={() => void choose(directory)}>{directory.split("/").filter(Boolean).at(-1) || directory}</button>)}</div>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="browse-directory" disabled={choosing} onClick={() => void choose()}>{choosing ? "Working…" : "Choose directory…"}</button><button disabled={choosing} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={choosing} onClick={() => void open()}>Open project</button></div>
  </dialog>;
}
