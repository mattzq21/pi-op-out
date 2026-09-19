import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Folder, FolderOpen, Search } from "lucide-react";
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

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const withSeparator = (path: string) => /[\\/]$/.test(path) ? path : path + (path.includes("\\") ? "\\" : "/");
const displayPath = (path: string, home: string) => {
  if (!home) return path;
  const normalized = path.replace(/\\/g, "/");
  const root = home.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === root || normalized === root + "/" ? "~/" : normalized.startsWith(root + "/") ? "~/" + normalized.slice(root.length + 1) : path;
};
const expandHome = (path: string, home: string) => {
  if (path === "~") return home;
  if (!/^~[\\/]/.test(path)) return path;
  return home ? withSeparator(home) + (home.includes("\\") ? path.slice(2).replace(/\//g, "\\") : path.slice(2)) : "";
};

function parentPath(typedParent: string, homePath: string, basePath: string) {
  return /^~[\\/]/.test(typedParent) ? expandHome(typedParent, homePath) : !typedParent ? basePath : /^(?:[\\/]|[a-z]:[\\/])/i.test(typedParent) ? typedParent : basePath ? withSeparator(basePath) + typedParent : typedParent;
}

function isHistoryShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.nativeEvent.isComposing && (key === "z" || key === "y");
}

export function ProjectDialog({ initialPath, hosts, initialHostId, onHomeDirectory, onChooseDirectory, onOpen, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const callbacks = useRef({ onHomeDirectory, onChooseDirectory });
  callbacks.current = { onHomeDirectory, onChooseDirectory };
  const initialLocation = useRef({ path: initialPath, hostId: initialHostId });
  const [hostId, setHostId] = useState(initialHostId);
  const [query, setQuery] = useState("");
  const queryHistory = useRef({ current: "", past: [] as string[], future: [] as string[] });
  const [basePath, setBasePath] = useState("");
  const [homePath, setHomePath] = useState("");
  const [loaded, setLoaded] = useState<{ hostId: string; requested: string; listing: DirectoryListing }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const [active, setActive] = useState(0);
  const [browseRequest, setBrowseRequest] = useState(0);
  const separator = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
  const typedParent = separator < 0 ? "" : query.slice(0, separator + 1);
  const parent = parentPath(typedParent, homePath, basePath);
  const fragment = query.slice(separator + 1);
  const listing = loaded?.hostId === hostId && loaded.requested === parent ? loaded.listing : undefined;
  const results = (listing?.directories ?? []).filter((path) => folderName(path).toLocaleLowerCase().includes(fragment.toLocaleLowerCase())).sort((a, b) => {
    const prefix = fragment.toLocaleLowerCase();
    return Number(folderName(b).toLocaleLowerCase().startsWith(prefix)) - Number(folderName(a).toLocaleLowerCase().startsWith(prefix)) || a.localeCompare(b);
  });
  const selected = results[active];
  const hasHomePrefix = query.startsWith("~/");
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  const resetQuery = (path: string) => {
    queryHistory.current = { current: path, past: [], future: [] };
    setQuery(path);
  };
  const changeQuery = (path: string) => {
    const history = queryHistory.current;
    if (path === history.current) return;
    history.past = [...history.past.slice(-199), history.current];
    history.current = path; history.future = [];
    setQuery(path); setActive(0); setError(undefined);
  };
  const navigateHistory = (redo: boolean) => {
    const history = queryHistory.current;
    const source = redo ? history.future : history.past;
    const path = source.pop();
    if (path === undefined) return;
    (redo ? history.past : history.future).push(history.current);
    history.current = path;
    setQuery(path); setActive(0); setError(undefined);
    setBrowseRequest((value) => value + 1);
    inputRef.current?.focus();
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(undefined); setBasePath(""); setHomePath(""); resetQuery(""); setLoading(true); setError(undefined);
    const initialize = async () => {
      const location = initialLocation.current;
      const home = await callbacks.current.onHomeDirectory(hostId);
      const path = location.hostId === hostId && location.path.trim() ? expandHome(location.path, home) : home;
      if (!cancelled) { setHomePath(home); setBasePath(path); resetQuery(withSeparator(displayPath(path, home))); }
    };
    void initialize().catch((reason) => { if (!cancelled) { setError(String(reason instanceof Error ? reason.message : reason)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [hostId]);

  useEffect(() => {
    if (!parent) return;
    let cancelled = false;
    setLoading(true); setError(undefined);
    const timer = setTimeout(() => {
      void callbacks.current.onChooseDirectory(parent, hostId).then((value) => {
        if (cancelled) return;
        if (value && typeof value !== "string") setLoaded({ hostId, requested: parent, listing: value });
        else { setLoaded(undefined); setError("Could not list this folder. Try another path."); }
      }).catch((reason) => { if (!cancelled) { setLoaded(undefined); setError(reason instanceof Error ? reason.message : String(reason)); } }).finally(() => { if (!cancelled) setLoading(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hostId, parent, browseRequest]);

  useEffect(() => { setActive(0); }, [query, loaded]);
  useEffect(() => { dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);

  const browse = (path: string) => { changeQuery(withSeparator(displayPath(expandHome(path, homePath), homePath))); setBrowseRequest((value) => value + 1); setActive(0); setError(undefined); inputRef.current?.focus(); };
  const open = async (path = listing?.path) => {
    if (!path || loading || openingRef.current) return;
    openingRef.current = true; setOpening(true); setError(undefined);
    try { await onOpen(path, hostId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { openingRef.current = false; setOpening(false); }
  };
  const handlePathKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || opening || event.metaKey || event.ctrlKey) return;
    const move = () => { event.preventDefault(); setActive((index) => results.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0); };
    const handlers: Record<string, () => void> = {
      ArrowDown: move, ArrowUp: move,
      Enter: () => { event.preventDefault(); if (fragment && selected) void open(selected); else if (query.trim()) void open(expandHome(query === "~" || /^(?:~[\\/]|[\\/]|[a-z]:[\\/])/i.test(query) ? query : withSeparator(basePath) + query, homePath)); },
      Tab: () => { if (!event.shiftKey && selected && !loading) { event.preventDefault(); browse(selected); } },
      Backspace: () => { if (event.altKey && listing?.parent) { event.preventDefault(); browse(listing.parent); } },
    };
    if (Object.hasOwn(handlers, event.key)) handlers[event.key]();
  };

  const renderDirectoryPaletteSearch = () => (<div className="directory-palette-search"><Search size={20} />{hasHomePrefix && <span className="directory-palette-prefix" aria-hidden="true">~/</span>}<input ref={inputRef} autoFocus role="combobox" aria-label={hasHomePrefix ? "Folder path relative to home" : "Search or type a folder path"} aria-autocomplete="list" aria-expanded="true" aria-controls="directory-palette-results" aria-activedescendant={!loading && selected ? "directory-result-" + active : undefined} autoComplete="off" spellCheck={false} placeholder="Type a folder path…" readOnly={opening} value={hasHomePrefix ? query.slice(2) : query} onChange={(event) => { changeQuery(hasHomePrefix ? "~/" + event.target.value.replace(/^~[\\/]/, "") : event.target.value); }} onKeyDown={handlePathKey} /></div>);
  const renderDirectoryPaletteCaption = () => (<div className="directory-palette-caption"><span>{loading ? "Finding folders…" : fragment ? results.length + " matching folders" : "Continue into a folder"}</span><span>Tab to complete · Enter to open</span></div>);
  const renderDirectoryPaletteResults = () => (<div id="directory-palette-results" className="directory-palette-results" role="listbox" aria-label="Matching folders" aria-busy={loading}>
      {!loading && results.map((path, index) => <div id={"directory-result-" + index} key={path} role="option" aria-selected={index === active} className="directory-palette-result" onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => { if (!opening) browse(path); }}><Folder size={17} /><span>{folderName(path)}</span></div>)}
      {!loading && !results.length && <div className="directory-palette-empty">{error ? "Check the path and try again." : fragment ? "No matches. Keep typing a path, or press Enter to open it." : "No child folders. Press Enter to open this folder."}</div>}
      {loading && <div className="directory-palette-empty" role="status">Loading folder suggestions…</div>}
    </div>);
  const renderDirectoryPaletteOpen = () => (<button className="directory-palette-open" disabled={!listing || loading || opening} onClick={() => void open()}><FolderOpen size={18} /><span><strong>{opening ? "Opening…" : "Open current folder"}</strong><small title={listing?.path}>{displayPath(listing?.path || parent, homePath) || "Type a path to begin"}</small></span><kbd>{isMac ? "⌘" : "Ctrl"} Enter</kbd></button>);
  return <dialog ref={dialogRef} className="extension-dialog directory-palette" aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); if (!openingRef.current) onCancel(); }} onMouseDown={(event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!openingRef.current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onCancel();
  }} onKeyDown={(event) => {
    const key = event.key.toLowerCase();
    if (isHistoryShortcut(event)) {
      event.preventDefault(); event.stopPropagation();
      if (!openingRef.current) navigateHistory(key === "y" || event.shiftKey);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void open(); }
  }}>
    <header className="directory-palette-heading"><h2 id="project-dialog-title">Jump to a folder</h2><select aria-label="Machine" disabled={opening} value={hostId} onChange={(event) => setHostId(event.target.value)}><option value="local">Local</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select><button className="directory-palette-escape" disabled={opening} onClick={onCancel}>esc</button></header>
    {renderDirectoryPaletteSearch()}
    {renderDirectoryPaletteCaption()}
    {renderDirectoryPaletteResults()}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {renderDirectoryPaletteOpen()}
    <footer className="directory-palette-hints"><span><ArrowUp size={12} /><ArrowDown size={12} /> navigate</span><span>Alt + Backspace parent</span></footer>
  </dialog>;
}
