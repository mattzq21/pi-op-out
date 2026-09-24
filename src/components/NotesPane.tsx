import { Check, Eye, FilePlus2, FileText, FolderOpen, Notebook, PanelRightClose, Pencil, RefreshCw, Save, Search, Trash2, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { markdownPath, noteName, notePreference, rememberNotePreference, resolveNoteLink, useNotes } from "../lib/notes";
import { IconButton } from "./IconButton";
import { Markdown } from "./Markdown";
import "./notes.css";

type FormAction = "create" | "rename" | "vault" | "copy";
type FormState = { action: FormAction; value: string };
const formLabels: Record<FormAction, string> = { create: "New note", rename: "Rename note", vault: "Open notes folder", copy: "Save draft as a copy" };

export function NotesPane(props: { hidden: boolean; open: boolean; onClose: () => void }) {
  const notes = useNotes();
  const [width, setWidth] = createSignal(Number(notePreference("width", "360")) || 360);
  const [viewportWidth, setViewportWidth] = createSignal(window.innerWidth);
  const [preview, setPreview] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [form, setForm] = createSignal<FormState>();
  const [confirmation, setConfirmation] = createSignal<"trash" | "reload">();
  const [dragging, setDragging] = createSignal(false);
  const [linkError, setLinkError] = createSignal("");
  const filtered = createMemo(() => notes.paths().filter(path => path.toLowerCase().includes(query().trim().toLowerCase())));
  const maxWidth = () => Math.max(300, Math.floor(viewportWidth() * .6));
  const visibleWidth = () => Math.min(maxWidth(), Math.max(300, width()));
  const wordCount = createMemo(() => notes.content().trim().split(/\s+/).filter(Boolean).length);
  let initialized = false;
  let drag: { x: number; width: number; pointer: number } | undefined;
  let editor: HTMLTextAreaElement | undefined;

  createEffect(() => {
    if (props.hidden || !props.open || initialized) return;
    initialized = true;
    void notes.openVault();
  });
  const resize = (value: number) => {
    const next = Math.round(Math.min(maxWidth(), Math.max(300, value)));
    setWidth(next);
    rememberNotePreference("width", String(next));
  };
  const onResize = () => setViewportWidth(window.innerWidth);
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));
  const focusEditor = () => { setPreview(false); queueMicrotask(() => editor?.focus()); };
  const begin = (action: FormAction, value = "") => { setConfirmation(undefined); setForm({ action, value }); };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = form();
    if (!current || !current.value.trim()) return;
    const actions = {
      create: () => notes.create(current.value),
      copy: () => notes.create(current.value, true),
      rename: () => notes.rename(current.value),
      vault: () => notes.openVault(current.value),
    };
    if (await actions[current.action]()) { setForm(undefined); setQuery(""); focusEditor(); }
  };
  const select = async (path: string) => {
    if (notes.busy()) return;
    setForm(undefined); setConfirmation(undefined); setLinkError("");
    await notes.open(path);
  };
  const openLink = (target: string) => {
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch { /* A literal percent sign is valid in a note title. */ }
    const path = resolveNoteLink(decoded, notes.document()?.path ?? "", notes.paths());
    if (path) { void select(path); return; }
    setLinkError(`No unique note found for “${decoded}”. Choose a note below or create it.`);
    begin("create", markdownPath(decoded.split("#")[0]));
  };
  const confirm = async () => {
    const action = confirmation();
    const succeeded = action === "trash" ? await notes.trash() : await notes.reload();
    if (succeeded) setConfirmation(undefined);
  };
  const editorKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation(); void notes.save();
    }
  };
  const status = () => notes.saving() ? "Saving…" : notes.dirty() ? "Unsaved changes" : "Saved to disk";
  const renderError = () => <Show when={notes.error() || linkError()}><div class="notes-error" role="alert">
    <span>{notes.error() || linkError()}</span>
    <Show when={notes.dirty()}><div class="notes-error-actions">
      <button disabled={notes.busy()} onClick={() => void notes.save()}>Retry save</button>
      <button disabled={notes.busy()} onClick={() => begin("copy", `${noteName(notes.document()!.path)} copy.md`)}>Save a copy</button>
      <button disabled={notes.busy()} onClick={() => { setForm(undefined); setConfirmation("reload"); }}>Reload file</button>
    </div></Show>
  </div></Show>;
  const renderConfirmation = () => <Show when={confirmation()}><div class="notes-confirm" role="alert">
    <p>{confirmation() === "trash" ? `Move “${notes.document()?.path}” to .trash?` : "Replace your unsaved draft with the file on disk?"}</p>
    <button disabled={notes.busy()} onClick={() => void confirm()}>{confirmation() === "trash" ? "Move to trash" : "Reload file"}</button>
    <button disabled={notes.busy()} onClick={() => setConfirmation(undefined)}>Cancel</button>
  </div></Show>;
  const renderDocument = () => <Show when={notes.document()} fallback={<div class="notes-empty"><Notebook size={30} /><strong>A place for your thoughts</strong><p>Keep plans, ideas, and references beside your conversations.</p><button class="primary-button" disabled={notes.busy() || !notes.ready()} onClick={() => begin("create")}>Create a note</button></div>}>
    <div class="notes-document-header"><strong title={notes.document()?.path}>{noteName(notes.document()!.path.split("/").at(-1)!)}</strong><IconButton label="Rename note" disabled={notes.busy()} onClick={() => begin("rename", notes.document()!.path)}><Pencil size={14} /></IconButton><IconButton label="Move note to trash" disabled={notes.busy()} onClick={() => { setForm(undefined); setConfirmation("trash"); }}><Trash2 size={14} /></IconButton></div>
    <div class="notes-editor-toolbar"><div role="group" aria-label="Note mode"><button aria-pressed={!preview()} classList={{ active: !preview() }} onClick={focusEditor}><Pencil size={13} />Edit</button><button aria-pressed={preview()} classList={{ active: preview() }} onClick={() => setPreview(true)}><Eye size={14} />Preview</button></div><IconButton label="Save note (Ctrl/Cmd+S)" disabled={notes.busy() || notes.saving() || !notes.dirty()} onClick={() => void notes.save()}><Save size={14} /></IconButton></div>
    <Show when={preview()} fallback={<textarea ref={editor} class="notes-editor" aria-label="Markdown note" placeholder={"# Untitled\n\nWrite in Markdown. Link ideas with [[Note name]]."} value={notes.content()} onInput={event => notes.edit(event.currentTarget.value)} onBlur={() => { if (!notes.busy()) void notes.save(); }} disabled={notes.busy()} spellcheck />}>
      <div class="notes-preview"><Show when={notes.content().trim()} fallback={<p class="notes-preview-empty">This note is empty. Switch to Edit to start writing.</p>}><Markdown onNoteLink={openLink}>{notes.content()}</Markdown></Show></div>
    </Show>
    <footer class="notes-status"><span classList={{ unsaved: notes.dirty() }} role="status">{status()}</span><span>{wordCount()} words · Markdown</span></footer>
  </Show>;

  return <aside id="notes-pane" class="notes-pane" hidden={props.hidden || !props.open} aria-label="Notes" style={{ "--notes-width": `${visibleWidth()}px` }} onKeyDown={editorKeyDown}>
    <Show when={props.open}>
      <div class={`notes-resizer ${dragging() ? "dragging" : ""}`} role="separator" tabIndex={0} aria-label="Notes pane width" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={maxWidth()} aria-valuenow={visibleWidth()}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          drag = { x: event.clientX, width: visibleWidth(), pointer: event.pointerId }; setDragging(true);
        }}
        onPointerMove={event => { if (drag?.pointer === event.pointerId) resize(drag.width + drag.x - event.clientX); }}
        onPointerUp={event => { if (drag?.pointer !== event.pointerId) return; drag = undefined; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
        onLostPointerCapture={() => { drag = undefined; setDragging(false); }}
        onPointerCancel={() => { drag = undefined; setDragging(false); }}
        onDblClick={() => resize(360)}
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); event.stopPropagation(); resize(visibleWidth() + (event.key === "ArrowLeft" ? 20 : -20));
        }} />
      <header class="notes-header">
        <Notebook size={17} /><strong>Notes</strong>
        <IconButton label="New note" disabled={notes.busy() || !notes.ready()} onClick={() => begin("create")}><FilePlus2 size={16} /></IconButton>
        <IconButton label="Open notes folder" disabled={notes.busy()} onClick={() => begin("vault", notes.root())}><FolderOpen size={16} /></IconButton>
        <IconButton label="Refresh notes" disabled={notes.busy()} onClick={() => void (notes.ready() ? notes.refresh() : notes.openVault())}><RefreshCw size={15} /></IconButton>
        <IconButton label="Close notes" onClick={props.onClose}><PanelRightClose size={17} /></IconButton>
      </header>
      <div class="notes-vault" title={notes.root()}>{notes.root() || "Your Markdown notebook"}</div>
      <Show when={form()}>{current => <form class="notes-form" onSubmit={submit}>
        <label for="note-filename">{formLabels[current().action]}</label>
        <div><input id="note-filename" ref={element => queueMicrotask(() => { element.focus(); element.select(); })} value={current().value} onInput={event => setForm({ ...current(), value: event.currentTarget.value })} placeholder={current().action === "vault" ? "/path/to/notes" : "Ideas/My note.md"} disabled={notes.busy()} autocomplete="off" required />
          <IconButton label="Confirm" type="submit" disabled={notes.busy()}><Check size={16} /></IconButton>
          <IconButton label="Cancel" type="button" disabled={notes.busy()} onClick={() => setForm(undefined)}><X size={16} /></IconButton></div>
        <small>{current().action === "vault" ? "Open an existing folder on this Piop host. Files stay in that folder." : "Use / to organize notes into folders. Files use Markdown."}</small>
      </form>}</Show>
      {renderError()}
      <label class="notes-search"><Search size={14} /><input aria-label="Search notes" placeholder="Find a note…" value={query()} onInput={event => setQuery(event.currentTarget.value)} /><span>{filtered().length}</span></label>
      <div class="notes-list" aria-label="Markdown files" aria-busy={notes.busy()}>
        <For each={filtered()}>{path => <button classList={{ selected: notes.document()?.path === path }} title={path} aria-current={notes.document()?.path === path ? "page" : undefined} disabled={notes.busy()} onClick={() => void select(path)}><FileText size={14} /><span>{noteName(path)}</span><small>.md</small></button>}</For>
        <Show when={notes.ready() && !filtered().length}><p>{query() ? "No matching notes" : "No notes yet"}</p></Show>
      </div>
      {renderConfirmation()}
      {renderDocument()}
    </Show>
  </aside>;
}
