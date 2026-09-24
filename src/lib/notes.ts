import { batch, createMemo, createSignal, onCleanup } from "solid-js";
import { invoke } from "./platform";

export type NoteDocument = { path: string; content: string; version: string };
type Vault = { root: string; paths: string[] };
const PREFIX = "piop-notes:";

export function notePreference(key: string, fallback = "") {
  try { return localStorage.getItem(PREFIX + key) ?? fallback; } catch { return fallback; }
}

export function rememberNotePreference(key: string, value: string) {
  try { localStorage.setItem(PREFIX + key, value); } catch { /* File storage remains available. */ }
}

const draftKey = (root: string, path: string) => PREFIX + JSON.stringify([root, path]);
function readDraft(root: string, path: string): NoteDocument | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(root, path)) ?? "null") as NoteDocument | null;
    if (value && typeof value.content === "string" && typeof value.version === "string") return value;
  } catch { /* Ignore an invalid recovery draft. */ }
}
function clearDraft(root: string, path: string) {
  try { localStorage.removeItem(draftKey(root, path)); } catch { /* Persistence is best-effort. */ }
}
function cacheDraft(root: string, current: NoteDocument, content: string) {
  try { localStorage.setItem(draftKey(root, current.path), JSON.stringify({ ...current, content })); } catch { /* The unload guard protects unsaved edits. */ }
}
export const noteName = (path: string) => path.replace(/\.md$/i, "");
export const markdownPath = (path: string) => /\.md$/i.test(path.trim()) ? path.trim() : `${path.trim()}.md`;

function normalizeLinkPath(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return undefined; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}

export function resolveNoteLink(target: string, currentPath: string, paths: string[]) {
  const name = markdownPath(target.split("#")[0]);
  const parent = currentPath.split("/").slice(0, -1).join("/");
  const relative = normalizeLinkPath(parent && !name.startsWith("/") ? `${parent}/${name}` : name)?.toLowerCase();
  const absolute = normalizeLinkPath(name)?.toLowerCase();
  const exact = paths.find(path => path.toLowerCase() === relative)
    ?? paths.find(path => path.toLowerCase() === absolute);
  if (exact) return exact;
  if (name.includes("/")) return undefined;
  const matches = paths.filter(path => path.split("/").at(-1)?.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

export function useNotes() {
  const [root, setRoot] = createSignal("");
  const [paths, setPaths] = createSignal<string[]>([]);
  const [document, setDocument] = createSignal<NoteDocument>();
  const [content, setContent] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [ready, setReady] = createSignal(false);
  const dirty = createMemo(() => !!document() && content() !== document()!.content);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | undefined;
  const request = <T>(action: string, args: Record<string, unknown> = {}) => invoke<T>("notes", { action, root: root(), ...args });
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const rememberSelection = (path: string) => rememberNotePreference(`selected:${root()}`, path);
  const updatePaths = (next: string[]) => setPaths([...new Set(next)].sort((a, b) => a.localeCompare(b)));

  const selectDocument = (next: NoteDocument, recover = true) => {
    const cached = recover ? readDraft(root(), next.path) : undefined;
    const draft = cached?.content !== next.content ? cached : undefined;
    if (cached && !draft) clearDraft(root(), next.path);
    batch(() => {
      setDocument(draft ? { ...next, version: draft.version } : next);
      setContent(draft?.content ?? next.content);
    });
    rememberSelection(next.path);
    if (draft && draft.content !== next.content) setError("Recovered an unsaved draft. Save it to continue, or save a copy if the file has changed.");
  };

  const drain = async () => {
    setSaving(true);
    try {
      while (dirty()) {
        const current = document()!;
        const body = content();
        const saved = await request<NoteDocument>("save", { path: current.path, content: body, version: current.version });
        setDocument(saved);
        if (content() === body) clearDraft(root(), current.path);
        else cacheDraft(root(), saved, content());
      }
      setError("");
      return true;
    } catch (reason) { report(reason); return false; }
    finally { setSaving(false); }
  };
  const save = (): Promise<boolean> => {
    clearTimeout(timer);
    if (inFlight) return inFlight;
    if (!dirty()) return Promise.resolve(true);
    inFlight = drain().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const edit = (body: string) => {
    setContent(body);
    const current = document();
    if (!current) return;
    cacheDraft(root(), current, body);
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 650);
  };
  const run = async (action: () => Promise<void>, flush = true) => {
    if (busy()) return false;
    setBusy(true);
    clearTimeout(timer);
    try {
      if (flush && !await save()) return false;
      if (inFlight) await inFlight;
      setError("");
      await action();
      return true;
    } catch (reason) { report(reason); return false; }
    finally { setBusy(false); }
  };
  const open = (path: string) => run(async () => selectDocument(await request<NoteDocument>("read", { path })));
  const openVault = (folder = notePreference("vault")) => run(async () => {
    const result = await request<Vault>("list", { root: folder });
    batch(() => { setRoot(result.root); setPaths(result.paths); setDocument(undefined); setContent(""); setReady(true); });
    rememberNotePreference("vault", result.root);
    const selected = notePreference(`selected:${result.root}`);
    const path = result.paths.includes(selected) ? selected : result.paths[0];
    if (path) selectDocument(await request<NoteDocument>("read", { path }));
  });
  const refresh = () => run(async () => {
    const result = await request<Vault>("list");
    setPaths(result.paths);
    const current = document();
    if (current) selectDocument(await request<NoteDocument>("read", { path: current.path }), false);
  });
  const create = (name: string, copy = false) => run(async () => {
    const path = markdownPath(name);
    const previous = document();
    const body = copy ? content() : "";
    const next = await request<NoteDocument>("create", { path, content: body });
    if (copy && previous) clearDraft(root(), previous.path);
    updatePaths([...paths(), next.path]);
    selectDocument(next, false);
  }, !copy);
  const rename = (name: string) => run(async () => {
    const current = document();
    if (!current) return;
    const next = await request<NoteDocument>("rename", { path: current.path, version: current.version, destination: markdownPath(name) });
    clearDraft(root(), current.path);
    updatePaths(paths().map(path => path === current.path ? next.path : path));
    selectDocument(next, false);
  });
  const trash = () => run(async () => {
    const current = document();
    if (!current) return;
    await request("trash", { path: current.path, version: current.version });
    clearDraft(root(), current.path);
    setPaths(paths().filter(path => path !== current.path));
    setDocument(undefined);
    setContent("");
    if (paths()[0]) selectDocument(await request<NoteDocument>("read", { path: paths()[0] }));
  });
  const reload = () => run(async () => {
    const current = document();
    if (!current) return;
    const next = await request<NoteDocument>("read", { path: current.path });
    clearDraft(root(), current.path);
    selectDocument(next, false);
  }, false);

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty()) return;
    event.preventDefault();
    event.returnValue = "";
    void save();
  };
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { clearTimeout(timer); window.removeEventListener("beforeunload", beforeUnload); void save(); });
  return { root, paths, document, content, busy, saving, error, ready, dirty, edit, save, open, openVault, refresh, create, rename, trash, reload };
}
