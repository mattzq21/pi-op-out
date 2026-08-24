import { useEffect, useState } from "react";
import type { DirectoryListing, RemoteHost } from "../types";

interface Props {
  initialPath: string;
  hosts: RemoteHost[];
  initialHostId: string;
  onHomeDirectory: (hostId: string) => Promise<string>;
  onChooseDirectory: (currentPath: string, hostId: string) => Promise<string | DirectoryListing | null>;
  onOpen: (path: string, hostId: string) => void;
  onCancel: () => void;
}

export function ProjectDialog({ initialPath, hosts, initialHostId, onHomeDirectory, onChooseDirectory, onOpen, onCancel }: Props) {
  const [path, setPath] = useState(initialPath);
  const [hostId, setHostId] = useState(initialHostId);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  useEffect(() => { let cancelled = false; setChoosing(true); setError(undefined); void onHomeDirectory(hostId).then((home) => { if (!cancelled) setPath(home); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) setChoosing(false); }); return () => { cancelled = true; }; }, [hostId, onHomeDirectory]);
  const open = () => { const value = path.trim(); if (!value) { setError("Path can't be empty"); return; } onOpen(value, hostId); };
  const choose = async (directory = path.trim()) => {
    setChoosing(true); setError(undefined);
    try { const selected = await onChooseDirectory(directory, hostId); if (typeof selected === "string") setPath(selected); else if (selected) { setPath(selected.path); setListing(selected); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChoosing(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <p className="eyebrow">Project</p><h2 id="project-dialog-title">Open project</h2><p>Open Pi in a project directory.</p>
      <label className="field"><span>Machine</span><select aria-label="Machine" value={hostId} onChange={(event) => { setHostId(event.target.value); setPath(""); setListing(undefined); setError(undefined); }}><option value="local">Local</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
      <input autoFocus aria-label="Project directory" value={path} placeholder="/path/to/project" onChange={(event) => { setPath(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") open(); }} />
      {hostId !== "local" && listing && <div className="remote-directory-list" aria-label="Remote directories">{listing.parent && <button onClick={() => void choose(listing.parent)}>..</button>}{listing.directories.map((directory) => <button key={directory} onClick={() => void choose(directory)}>{directory.split("/").filter(Boolean).at(-1) || directory}</button>)}</div>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="browse-directory" disabled={choosing} onClick={() => void choose()}>{choosing ? "Choosing…" : "Choose directory…"}</button><button onClick={onCancel}>Cancel</button><button className="primary-button" onClick={open}>Open project</button></div>
    </section>
  </div>;
}
