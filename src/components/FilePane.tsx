import { ArrowLeft, File, Folder, RefreshCw, Save, X } from "lucide-solid";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, on, Show } from "solid-js";
import { listProjectFiles, readProjectFile, saveProjectFile, type FileProject, type FileReference, type ProjectDirectory, type ProjectFile } from "../lib/projectFiles";
import { CodeEditor } from "./CodeEditor";
import type { FilePaneRequest } from "./FileWorkspace";

export function FilePane(props: { request: FilePaneRequest; onClose: () => void }) {
  const [width, setWidth] = createSignal<number | undefined>((() => {
    try {
      const saved = Number(localStorage.getItem("piop.files.width"));
      return Number.isFinite(saved) && saved >= 300 ? saved : undefined;
    } catch { return undefined; }
  })());
  const [workspaceWidth, setWorkspaceWidth] = createSignal(window.innerWidth);
  const [dragging, setDragging] = createSignal(false);
  const maxWidth = () => Math.max(300, Math.floor(workspaceWidth() * .7));
  const visibleWidth = () => Math.min(maxWidth(), Math.max(300, width() ?? workspaceWidth() * .46));
  const resize = (value: number) => {
    const next = Math.round(Math.min(maxWidth(), Math.max(300, value)));
    setWidth(next);
    try { localStorage.setItem("piop.files.width", String(next)); } catch { /* Width persistence is optional. */ }
  };
  let pane!: HTMLElement;
  let drag: { x: number; width: number; pointer: number } | undefined;
  onMount(() => {
    const workspace = pane.parentElement!;
    const observer = new ResizeObserver(() => setWorkspaceWidth(workspace.clientWidth));
    setWorkspaceWidth(workspace.clientWidth);
    observer.observe(workspace);
    onCleanup(() => observer.disconnect());
  });
  const [project, setProject] = createSignal<FileProject>(props.request.project);
  const [directory, setDirectory] = createSignal<ProjectDirectory>();
  const [file, setFile] = createSignal<ProjectFile>();
  const [draft, setDraft] = createSignal("");
  const [location, setLocation] = createSignal<FileReference>();
  const [filter, setFilter] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [listing, setListing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [pending, setPending] = createSignal<() => void>();
  const [editorVersion, setEditorVersion] = createSignal(0);
  const dirty = createMemo(() => Boolean(file() && draft() !== file()!.content));
  const entries = createMemo(() => (directory()?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(filter().toLowerCase())));
  let fileVersion = 0;
  let directoryVersion = 0;
  let disposed = false;

  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const navigate = (action: () => void) => {
    if (saving()) return;
    if (dirty()) setPending(() => action);
    else action();
  };
  const list = async (path: string) => {
    const version = ++directoryVersion;
    setListing(true); setFilter(""); setError(undefined);
    try { const result = await listProjectFiles(project(), path); if (version === directoryVersion) setDirectory(result); }
    catch (reason) { if (version === directoryVersion) report(reason); }
    finally { if (version === directoryVersion) setListing(false); }
  };
  const openFile = async (reference: FileReference) => {
    const version = ++fileVersion;
    setLoading(true); setError(undefined); setSaved(false);
    try {
      const result = await readProjectFile(project(), reference.path);
      if (version !== fileVersion) return;
      batch(() => { setFile(result); setDraft(result.content); setLocation(reference); setEditorVersion(version); setLoading(false); });
    } catch (reason) { if (version === fileVersion) report(reason); }
    finally { if (version === fileVersion) setLoading(false); }
  };
  const chooseFile = (reference: FileReference) => {
    if (isCurrentFile(reference)) { setLocation({ ...reference }); return; }
    navigate(() => { void openFile(reference); });
  };
  const isCurrentFile = (reference: FileReference) => {
    const current = file();
    if (!current) return false;
    const requested = reference.path.replaceAll("\\", "/").replace(/^\.\//, "");
    const absolute = `${project().cwd.replaceAll("\\", "/").replace(/\/$/, "")}/${current.path}`;
    return requested === current.path || requested === absolute;
  };
  const save = async () => {
    const current = file();
    if (!current || saving() || loading()) return false;
    const content = draft();
    setSaving(true); setError(undefined); setSaved(false);
    try {
      const result = await saveProjectFile(project(), current, content);
      if (disposed) return false;
      setFile(result); setSaved(draft() === content);
      return true;
    } catch (reason) { if (!disposed) report(reason); return false; }
    finally { if (!disposed) setSaving(false); }
  };
  const continueNavigation = () => { const action = pending(); setPending(undefined); action?.(); };
  const saveAndContinue = async () => { if (await save() && !dirty()) continueNavigation(); };
  const applyRequest = (request: FilePaneRequest) => {
    const sameProject = request.project.cwd === project().cwd && request.project.hostId === project().hostId;
    if (sameProject && !request.file) { void list(""); return; }
    if (sameProject && request.file && isCurrentFile(request.file)) { setLocation({ ...request.file }); return; }
    navigate(() => {
      if (!sameProject) { fileVersion++; setLoading(false); setFile(undefined); setDraft(""); setDirectory(undefined); setProject(request.project); }
      void list("");
      if (request.file) void openFile(request.file);
    });
  };
  createEffect(on(() => props.request, applyRequest));
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { disposed = true; fileVersion++; directoryVersion++; window.removeEventListener("beforeunload", beforeUnload); });

  const renderBrowser = () => <nav class="file-browser" aria-label="Project directory">
    <div class="file-browser-toolbar"><button type="button" aria-label="Parent directory" disabled={listing() || directory()?.parent == null} onClick={() => void list(directory()!.parent!)}><ArrowLeft size={14} /></button><span title={directory()?.path}>{directory()?.path || "/"}</span><button type="button" aria-label="Refresh files" disabled={listing()} onClick={() => void list(directory()?.path ?? "")}><RefreshCw size={14} /></button></div>
    <input type="search" aria-label="Filter files" placeholder="Filter files…" value={filter()} onInput={event => setFilter(event.target.value)} />
    <div class="file-browser-list" aria-busy={listing()}><Show when={!listing()} fallback={<p role="status">Loading files…</p>}><For each={entries()} fallback={<p>No files found.</p>}>{entry => <button type="button" class={file()?.path === entry.path ? "selected" : undefined} title={entry.path} onClick={() => entry.directory ? void list(entry.path) : chooseFile({ path: entry.path })} disabled={saving() || loading()}>{entry.directory ? <Folder size={14} /> : <File size={14} />}<span>{entry.name}</span></button>}</For></Show></div>
  </nav>;
  const editorStatus = () => loading() ? "Opening…" : saving() ? "Saving…" : saved() ? "Saved" : dirty() ? "Unsaved" : "";
  const renderEditor = () => <Show when={file()} fallback={<div class="file-pane-empty" role="status">{loading() ? "Opening file…" : "Choose a file to open it here."}</div>}>
    <div class="file-editor-toolbar"><span title={file()!.path}>{file()!.path}{dirty() ? " •" : ""}</span><small role="status">{editorStatus()}</small><button type="button" aria-label="Reload file" title="Reload file" disabled={saving() || loading()} onClick={() => navigate(() => { void openFile({ path: file()!.path }); })}><RefreshCw size={14} /></button><button type="button" disabled={!dirty() || saving() || loading()} onClick={() => void save()} title="Save (Ctrl/Cmd+S)"><Save size={14} />Save</button></div>
    <Show when={editorVersion()} keyed>{_version => <CodeEditor filename={file()!.path} value={draft()} disabled={loading()} location={location()} onChange={value => { setDraft(value); setSaved(false); }} onSave={() => { void save(); }} />}</Show>
  </Show>;
  return <aside ref={pane} class="file-pane" aria-label="Project files" style={{ "--files-width": `${visibleWidth()}px` }}>
    <div class={`files-resizer ${dragging() ? "dragging" : ""}`} role="separator" tabIndex={0} aria-label="Files pane width" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={maxWidth()} aria-valuenow={Math.round(visibleWidth())}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        drag = { x: event.clientX, width: visibleWidth(), pointer: event.pointerId }; setDragging(true);
      }}
      onPointerMove={event => { if (drag?.pointer === event.pointerId) resize(drag.width + drag.x - event.clientX); }}
      onPointerUp={event => { if (drag?.pointer !== event.pointerId) return; drag = undefined; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag = undefined; setDragging(false); }}
      onPointerCancel={() => { drag = undefined; setDragging(false); }}
      onDblClick={() => resize(workspaceWidth() * .46)}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); resize(visibleWidth() + (event.key === "ArrowLeft" ? 20 : -20));
      }} />
    <header class="file-pane-heading"><Folder size={16} /><strong>Files</strong><span title={project().cwd}>{project().cwd.split(/[\\/]/).filter(Boolean).at(-1)}</span><button type="button" aria-label="Close files" onClick={() => navigate(props.onClose)} disabled={saving()}><X size={16} /></button></header>
    <div class="file-pane-project" title={project().cwd}>{project().hostId !== "local" && `${project().hostId} · `}{project().cwd}</div>
    <Show when={pending()}><div class="file-pane-unsaved" role="alert"><span>Save changes to {file()?.path} before continuing?</span><div><button type="button" disabled={saving()} onClick={() => void saveAndContinue()}>Save</button><button type="button" disabled={saving()} onClick={continueNavigation}>Discard changes</button><button type="button" disabled={saving()} onClick={() => setPending(undefined)}>Cancel</button></div></div></Show>
    <Show when={error()}><div class="file-pane-error" role="alert">{error()}</div></Show>
    {renderBrowser()}
    {renderEditor()}
  </aside>;
}
