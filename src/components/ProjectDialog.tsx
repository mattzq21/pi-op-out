import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, FolderOpen, Home, Search } from "lucide-react";
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
  const pathRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [path, setPath] = useState(initialPath);
  const [hostId, setHostId] = useState(initialHostId);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const choosingRef = useRef(false);
  const [listing, setListing] = useState<DirectoryListing>();
  const [filter, setFilter] = useState("");
  const [opening, setOpening] = useState(false);
  const initialLocation = useRef({ hostId: initialHostId, path: initialPath });
  const directoryCallbacks = useRef({ onHomeDirectory, onChooseDirectory });
  directoryCallbacks.current = { onHomeDirectory, onChooseDirectory };
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); const frame = requestAnimationFrame(() => pathRef.current?.focus()); return () => { cancelAnimationFrame(frame); if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); }; }, []);
  useEffect(() => {
    let cancelled = false; choosingRef.current = true; setChoosing(true); setError(undefined); setListing(undefined); setFilter("");
    const load = async () => {
      const directory = hostId === initialLocation.current.hostId && initialLocation.current.path.trim() ? initialLocation.current.path : await directoryCallbacks.current.onHomeDirectory(hostId);
      if (cancelled) return;
      setPath(directory);
      const selected = await directoryCallbacks.current.onChooseDirectory(directory, hostId);
      if (cancelled) return;
      if (typeof selected === "string") setPath(selected);
      else if (selected) { setPath(selected.path); setListing(selected); }
    };
    void load().catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) { choosingRef.current = false; setChoosing(false); } });
    return () => { cancelled = true; };
  }, [hostId]);
  const open = async () => { if (choosingRef.current) return; const normalizedPath = path.trim(); if (!normalizedPath) { setError("Path can't be empty"); return; } choosingRef.current = true; setChoosing(true); setOpening(true); setError(undefined); try { await onOpen(normalizedPath, hostId); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { choosingRef.current = false; setChoosing(false); setOpening(false); } };
  const choose = async (directory = path, home = false) => {
    if (choosingRef.current) return; choosingRef.current = true; setChoosing(true); setError(undefined);
    try { const selected = await onChooseDirectory(home ? await onHomeDirectory(hostId) : directory.trim(), hostId); if (typeof selected === "string") { setPath(selected); setListing(undefined); } else if (selected) { setPath(selected.path); setListing(selected); setFilter(""); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { choosingRef.current = false; setChoosing(false); }
  };
  const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;
  const directories = listing?.directories.filter((directory) => folderName(directory).toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  return <dialog ref={dialogRef} className="extension-dialog project-dialog" aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); if (!opening) onCancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (!opening && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onCancel(); }}>
      <p className="eyebrow">Project</p><h2 id="project-dialog-title">Open project</h2><p>Find a folder to start working in.</p>
      <label className="field"><span>Machine</span><select aria-label="Machine" disabled={choosing} value={hostId} onChange={(event) => { setHostId(event.target.value); setPath(""); setListing(undefined); setError(undefined); }}><option value="local">Local</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
      <label className="project-path-label" htmlFor="project-path">Folder path</label>
      <div className="project-navigation">
        <button className="icon-button" aria-label="Go to home folder" title="Home folder" disabled={choosing} onClick={() => void choose("", true)}><Home size={16} /></button>
        <button className="icon-button" aria-label="Go to parent folder" title="Parent folder" disabled={choosing || !listing?.parent} onClick={() => void choose(listing!.parent)}><ArrowUp size={16} /></button>
        <input id="project-path" ref={pathRef} autoFocus disabled={choosing} value={path} placeholder="/path/to/project" onChange={(event) => { setPath(event.target.value); setListing(undefined); setFilter(""); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void choose(); } }} />
        <button className="project-go" disabled={choosing || !path.trim()} onClick={() => void choose()}>Go</button>
      </div>
      <div className="project-browser" aria-busy={choosing && !opening}>
        <label className="project-filter"><Search size={15} /><input aria-label="Filter folders" placeholder="Filter folders…" value={filter} disabled={choosing || !listing} onChange={(event) => setFilter(event.target.value)} /><span>{listing?.directories.length ?? 0}</span></label>
        <div className="project-folders" aria-label="Folders">
          {choosing && !opening ? <p className="project-empty" role="status">Loading folders…</p> : !listing ? <p className="project-empty">Enter a path and choose Go to browse its folders.</p> : directories.length === 0 ? <p className="project-empty">{filter ? "No folders match your filter." : "No subfolders. You can open this folder."}</p> : directories.map((directory) => <button key={directory} disabled={choosing} onClick={() => void choose(directory)}><Folder size={17} /><span>{folderName(directory)}</span><ChevronRight size={15} /></button>)}
        </div>
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="project-selection"><FolderOpen size={18} /><div><span>Selected folder</span><strong title={path}>{path.trim() || "Choose a folder"}</strong></div></div>
      <div className="dialog-actions"><button disabled={opening} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={choosing || !path.trim()} onClick={() => void open()}>{opening ? "Opening…" : "Open project"}</button></div>
  </dialog>;
}
