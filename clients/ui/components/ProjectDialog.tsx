import { z } from "zod";
import { required } from "../lib/required";
import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSelector, createSignal } from "solid-js";
import { createDependencyEffect, createRef, type KeyboardEvent } from "../lib/solid";

import { ArrowDown, ArrowUp, Folder, FolderOpen, Search } from "lucide-solid";
import type { DirectoryListing } from "../types";

interface Props {
  initialPath: string;
  hostId: string;
  hosts?: { id: string; name: string; disabled?: boolean }[];
  onHomeDirectory: (hostId: string) => Promise<string>;
  onChooseDirectory: (currentPath: string, hostId: string) => Promise<string | DirectoryListing | null>;
  onOpen: (path: string, hostId: string) => Promise<void>;
  onCancel: () => void;
}

const isWindowsPath = (path: string) => /^(?:[a-z]:[\\/]|\\\\)/i.test(path);

const isAbsolutePath = (path: string) => path.startsWith("/") || isWindowsPath(path);

const folderName = (path: string) => path.split(isWindowsPath(path) ? /[\\/]/ : /\//).filter(Boolean).at(-1) || path;

const withSeparator = (path: string) => (isWindowsPath(path) ? /[\\/]$/ : /\/$/).test(path) ? path : path + (isWindowsPath(path) ? "\\" : "/");

const displayPath = (path: string, home: string) => {
  if (!home) return path;
  const normalized = isWindowsPath(home) ? path.replace(/\\/g, "/") : path;
  const root = (isWindowsPath(home) ? home.replace(/\\/g, "/") : home).replace(/\/+$/, "");

  return normalized === root || normalized === root + "/" ? "~/" : normalized.startsWith(root + "/") ? "~/" + normalized.slice(root.length + 1) : path;
};

const expandHome = (path: string, home: string) => {
  if (path === "~") return home;

  if (!(isWindowsPath(home) ? /^~[\\/]/ : /^~\//).test(path)) return path;

  return home ? withSeparator(home) + (isWindowsPath(home) ? path.slice(2).replace(/\//g, "\\") : path.slice(2)) : "";
};

function parentPath(typedParent: string, homePath: string, basePath: string) {
  return (isWindowsPath(homePath) ? /^~[\\/]/ : /^~\//).test(typedParent) ? expandHome(typedParent, homePath) : !typedParent ? basePath : isAbsolutePath(typedParent) ? typedParent : basePath ? withSeparator(basePath) + typedParent : typedParent;
}

function isHistoryShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();

  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && (key === "z" || key === "y");
}

export function ProjectDialog(componentProps: Props) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const inputRef = createRef<HTMLInputElement>(null);
  const returnFocusRef = createRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const callbacks = createRef({ onHomeDirectory: componentProps.onHomeDirectory, onChooseDirectory: componentProps.onChooseDirectory });
  createComputed(() => { callbacks.current = { onHomeDirectory: componentProps.onHomeDirectory, onChooseDirectory: componentProps.onChooseDirectory }; });
  const initialLocation = createRef({ path: componentProps.initialPath, hostId: componentProps.hostId });
  const [hostId, setHostId] = createSignal(componentProps.hostId);
  const [query, setQuery] = createSignal("");
  const queryHistory = createRef<{ current: string; past: string[]; future: string[] }>({ current: "", past: [], future: [] });
  const queryRevision = createRef(0);
  const [basePath, setBasePath] = createSignal("");
  const [homePath, setHomePath] = createSignal("");
  const [loaded, setLoaded] = createSignal<{ hostId: string; requested: string; listing: DirectoryListing }>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  const [opening, setOpening] = createSignal(false);
  const openingRef = createRef(false);
  const [active, setActive] = createSignal(0);
  const isActive = createSelector(active);
  const [browseRequest, setBrowseRequest] = createSignal(0);
  const separator = createMemo(() => (Math.max(query().lastIndexOf("/"), isWindowsPath(homePath()) || isWindowsPath(query()) ? query().lastIndexOf("\\") : -1)));
  const typedParent = createMemo(() => (separator() < 0 ? "" : query().slice(0, separator() + 1)));
  const parent = createMemo(() => (parentPath(typedParent(), homePath(), basePath())));
  const fragment = createMemo(() => (query().slice(separator() + 1)));
  const listing = createMemo(() => (loaded()?.hostId === hostId() && required((loaded())).requested === parent() ? required((loaded())).listing : undefined));

  const directories = createMemo(() => (listing()?.directories ?? []).map(path => {
    const name = folderName(path);

    return { path, name, lower: name.toLocaleLowerCase() };
  }));

  const results = createMemo(() => {
    const query = fragment(), prefix = query.toLocaleLowerCase();

    return directories().filter(entry => entry.lower.includes(prefix)).sort((a, b) => {
      const exact = Number(b.name === query) - Number(a.name === query);

      if (exact) return exact;

      return Number(b.lower.startsWith(prefix)) - Number(a.lower.startsWith(prefix)) || a.path.localeCompare(b.path);
    }).map(entry => entry.path);
  });

  const selected = createMemo(() => (results()[active()]));
  const hasHomePrefix = createMemo(() => (query().startsWith("~/")));
  const isMac = createMemo(() => (/Mac|iPhone|iPad/.test(navigator.platform)));

  const resetQuery = (path: string) => {
    queryRevision.current += 1;
    queryHistory.current = { current: path, past: [], future: [] };
    setQuery(path);
  };

  const changeQuery = (path: string) => {
    const history = queryHistory.current;

    if (path === history.current) return;
    queryRevision.current += 1;
    history.past = [...history.past.slice(-199), history.current];
    history.current = path; history.future = [];
    setQuery(path); setActive(0); setError(undefined);
  };

  const navigateHistory = (redo: boolean) => {
    const history = queryHistory.current;
    const source = redo ? history.future : history.past;
    const path = source.pop();

    if (path === undefined) return;
    queryRevision.current += 1;
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

  createDependencyEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();

    return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  }, () => []);

  createDependencyEffect(() => { const capturedHostId = hostId();
    let cancelled = false;
    setLoaded(undefined); setBasePath(""); setHomePath(""); resetQuery(""); setLoading(true); setError(undefined);
    const initialQueryRevision = queryRevision.current;

    const initialize = async () => {
      const location = initialLocation.current;
      const home = await callbacks.current.onHomeDirectory(capturedHostId);
      const path = location.hostId === capturedHostId && location.path.trim() ? expandHome(location.path, home) : home;

      if (!cancelled) {
        setHomePath(home); setBasePath(path);

        if (queryRevision.current === initialQueryRevision) resetQuery(withSeparator(displayPath(path, home)));
      }
    };

    void initialize().catch((reason) => { if (!cancelled) { setError(String(reason instanceof Error ? reason.message : reason)); setLoading(false); } });

    return () => { cancelled = true; };
  }, () => [hostId()]);

  createDependencyEffect(() => { const capturedParent = parent(); const capturedHostId = hostId();

    if (!capturedParent) return;
    let cancelled = false;
    setLoading(true); setError(undefined);

    const timer = setTimeout(() => {
      void callbacks.current.onChooseDirectory(capturedParent, capturedHostId).then((value) => {
        if (cancelled) return;

        const listing = z.object({ path: z.string(), parent: z.string().optional(), directories: z.array(z.string()) }).safeParse(value);

        if (listing.success) setLoaded({ hostId: capturedHostId, requested: capturedParent, listing: listing.data });
        else { setLoaded(undefined); setError("Could not list this folder. Try another path."); }
      }).catch((reason) => { if (!cancelled) { setLoaded(undefined); setError(reason instanceof Error ? reason.message : String(reason)); } }).finally(() => { if (!cancelled) setLoading(false); });
    }, 150);

    return () => { cancelled = true; clearTimeout(timer); };
  }, () => [hostId(), parent(), browseRequest()]);

  createDependencyEffect(() => { setActive(0); }, () => [query(), loaded()]);
  createDependencyEffect(() => { dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, () => [active()]);

  const browse = (path: string) => { changeQuery(withSeparator(displayPath(expandHome(path, homePath()), homePath()))); setBrowseRequest((value) => value + 1); setActive(0); setError(undefined); inputRef.current?.focus(); };

  const open = async (path = listing()?.path) => { const capturedLoading = loading(); const capturedHostId = hostId(); const capturedOnOpen0 = componentProps.onOpen;

    if (!path || capturedLoading || openingRef.current) return;
    openingRef.current = true; setOpening(true); setError(undefined);

    try { await capturedOnOpen0(path, capturedHostId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { openingRef.current = false; setOpening(false); }
  };

  const handlePathKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.isComposing || opening() || event.metaKey || event.ctrlKey) return;
    const move = () => { event.preventDefault(); setActive((index) => results().length ? (index + (event.key === "ArrowDown" ? 1 : -1) + results().length) % results().length : 0); };

    const handlers = new Map(Object.entries({
      ArrowDown: move, ArrowUp: move,
      Enter: () => { event.preventDefault();

      if (fragment() && selected()) void open(selected()); else if (query()) void open(expandHome(query() === "~" || query().startsWith("~/") || isWindowsPath(homePath()) && query().startsWith("~\\") || isAbsolutePath(query()) ? query() : withSeparator(basePath()) + query(), homePath())); },
      Tab: () => { if (!event.shiftKey && selected() && !loading()) { event.preventDefault(); browse(selected()); } },
      Backspace: () => { if (event.altKey && listing()?.parent) { event.preventDefault(); browse(required(required((listing())).parent)); } },
    }));

    handlers.get(event.key)?.();
  };

  const renderDirectoryPaletteSearch = () => (<div class="directory-palette-search"><Search size={20} />{hasHomePrefix() && <span class="directory-palette-prefix" aria-hidden="true">~/</span>}<input ref={element => { inputRef.current = element; }} autofocus role="combobox" aria-label={hasHomePrefix() ? "Folder path relative to home" : "Search or type a folder path"} aria-autocomplete="list" aria-expanded="true" aria-controls="directory-palette-results" aria-activedescendant={!loading() && selected() ? "directory-result-" + active() : undefined} autocomplete="off" spellcheck={false} placeholder="Type a folder path…" readOnly={opening()} value={hasHomePrefix() ? query().slice(2) : query()} onInput={(event) => { const value = event.target.value; changeQuery(hasHomePrefix() && !isAbsolutePath(value) && !value.startsWith("~") ? "~/" + value : value); }} onKeyDown={handlePathKey} /></div>);
  const renderDirectoryPaletteCaption = () => (<div class="directory-palette-caption"><span>{loading() ? "Finding folders…" : fragment() ? results().length + " matching folders" : "Continue into a folder"}</span><span>Tab to complete · Enter to open</span></div>);

  const renderDirectoryPaletteResults = () => (<div id="directory-palette-results" class="directory-palette-results" role="listbox" aria-label="Matching folders" aria-busy={loading()}>
      {!loading() && <Key each={results()} by={(path) => path}>{(path, index) => <div id={"directory-result-" + index()}  role="option" aria-selected={isActive(index())} class="directory-palette-result" onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index())} onClick={() => { if (!opening()) browse(path()); }}><Folder size={17} /><span>{folderName(path())}</span></div>}</Key>}
      {!loading() && !results().length && <div class="directory-palette-empty">{error() ? "Check the path and try again." : fragment() ? "No matches. Keep typing a path, or press Enter to open it." : "No child folders. Press Enter to open this folder."}</div>}
      {loading() && <div class="directory-palette-empty" role="status">Loading folder suggestions…</div>}
    </div>);

  const renderDirectoryPaletteOpen = () => (<button class="directory-palette-open" disabled={!listing() || loading() || opening()} onClick={() => void open()}><FolderOpen size={18} /><span><strong>{opening() ? "Opening…" : "Open current folder"}</strong><small data-tooltip={listing()?.path}>{displayPath(listing()?.path || parent(), homePath()) || "Type a path to begin"}</small></span><kbd>{isMac() ? "⌘" : "Ctrl"} Enter</kbd></button>);

  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog directory-palette" data-custom-history aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault();

  if (!openingRef.current) componentProps.onCancel(); }} onMouseDown={(event) => {
    const bounds = event.currentTarget.getBoundingClientRect();

    if (!openingRef.current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) componentProps.onCancel();
  }} onKeyDown={(event) => {
    const key = event.key.toLowerCase();

    if (isHistoryShortcut(event)) {
      event.preventDefault(); event.stopPropagation();

      if (!openingRef.current) navigateHistory(key === "y" || event.shiftKey);

      return;
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); void open(); }
  }}>
    <header class="directory-palette-heading"><h2 id="project-dialog-title">Jump to a folder</h2>{componentProps.hosts && <select aria-label="Host" disabled={opening()} value={hostId()} onChange={(event) => setHostId(event.target.value)}><Key each={componentProps.hosts} by={host => host.id}>{(host) => <option value={host().id} disabled={host().disabled}>{host().name}</option>}</Key></select>}<button class="directory-palette-escape" disabled={opening()} onClick={componentProps.onCancel}>esc</button></header>
    {renderDirectoryPaletteSearch()}
    {renderDirectoryPaletteCaption()}
    {renderDirectoryPaletteResults()}
    {error() && <p class="dialog-error" role="alert">{(error())}</p>}
    {renderDirectoryPaletteOpen()}
    <footer class="directory-palette-hints"><span><ArrowUp size={12} /><ArrowDown size={12} /> navigate</span><span>Alt + Backspace parent</span></footer>
  </dialog>;
}
