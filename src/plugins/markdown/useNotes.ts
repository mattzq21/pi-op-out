import { createSignal, onCleanup, onMount } from "solid-js";
import { z } from "zod";
import { invoke } from "../../lib/platform";
import { required } from "../../lib/required";
import { registerPluginFlush } from "../lifecycle";

const noteSchema = z.object({ content: z.string(), version: z.string() });

type NoteDocument = z.infer<typeof noteSchema>;

export interface ChatNoteTarget { sessionId: string; hostId: string; }

function readDraft(key: string) {
  try {
    const result = noteSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));

    if (result.success) return result.data;
  } catch { }
}

export function useChatNote(target: ChatNoteTarget) {
  const [document, setDocument] = createSignal<NoteDocument>();
  const [content, setContent] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [readError, setReadError] = createSignal("");
  const [saveError, setSaveError] = createSignal("");
  const error = () => readError() || saveError();
  const draftKey = "piop-chat-note:" + JSON.stringify([target.hostId, target.sessionId]);
  const draftOwner = crypto.randomUUID();
  let draftRevision: string | null | undefined;

  try {
    const stored = localStorage.getItem(draftKey);
    const cached = noteSchema.safeParse(JSON.parse(stored ?? "null"));
    draftRevision = stored;

    if (cached.success) {
      const claimed = JSON.stringify({ ...cached.data, owner: draftOwner });
      localStorage.setItem(draftKey, claimed);
      draftRevision = claimed;
    }
  } catch { }

  const dirty = () => !!document() && content() !== document()?.content;
  let disposed = false;
  let inFlight: Promise<boolean> | undefined;
  const pendingWork = () => !!inFlight || dirty();
  let checking = false;
  const request = (action: string, fields: Record<string, string> = {}) => invoke("plugin_call", { hostId: target.hostId, pluginId: "markdown", request: { sessionId: target.sessionId, action, ...fields } }, noteSchema);

  const cache = (current: NoteDocument, body: string, reclaim = false) => {
    try {
      if (!reclaim && localStorage.getItem(draftKey) !== draftRevision) return;
      const next = JSON.stringify({ ...current, content: body, owner: draftOwner });
      localStorage.setItem(draftKey, next);
      draftRevision = next;
    } catch { }
  };

  const clearDraft = () => {
    try {
      if (localStorage.getItem(draftKey) !== draftRevision) return;
      localStorage.removeItem(draftKey);
      draftRevision = null;
    } catch { }
  };

  const selectDocument = (next: NoteDocument, recover: boolean) => {
    const cached = recover ? readDraft(draftKey) : undefined;
    const draft = cached?.content !== next.content ? cached : undefined;
    setDocument(draft ? { ...next, version: draft.version } : next);
    setContent(draft?.content ?? next.content);

    if (draft) setSaveError("Recovered your unsaved note. Save it to continue.");
    else clearDraft();
  };

  const load = async (recover = true) => {
    setLoading(true);
    setReadError("");

    try {
      const next = await request("read");

      if (disposed) return;
      selectDocument(next, recover);
    } catch (reason) { if (!disposed) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setLoading(false); }
  };

  const drain = async () => {
    setSaving(true);

    try {
      while (dirty()) {
        const current = required(document());
        const body = content();
        const saved = await request("save", { content: body, version: current.version });
        setDocument(saved);

        if (saved.content !== body) setContent(saved.content);

        if (!dirty()) clearDraft();
        else cache(saved, content());
      }

      setSaveError("");

      return true;
    } catch (reason) { setSaveError(dirty() ? (reason instanceof Error ? reason.message : String(reason)) : "");

      if (!dirty()) clearDraft();

      return false; }
    finally { setSaving(false); }
  };

  const save = (): Promise<boolean> => {
    if (inFlight) return inFlight;

    if (!document()) return Promise.resolve(false);

    if (!dirty()) { setSaveError(""); clearDraft();

      return Promise.resolve(true); }

    inFlight = drain().finally(() => { inFlight = undefined; });

    return inFlight;
  };

  const edit = (body: string) => {
    const current = document();

    if (!current || loading()) return;
    setContent(body);
    cache(current, body, true);
    void save();
  };

  onCleanup(registerPluginFlush(target.hostId, async () => {
    if (pendingWork() && !await save()) throw new Error("The note could not be saved. Retry saving it before restarting plugins.");
  }));

  const receiveUpdate = (next: NoteDocument, current: NoteDocument | undefined) => {
    if (!current) { selectDocument(next, true);

      return; }

    if (next.version === current.version) return;
    selectDocument(next, false);
    setSaveError("");
  };

  const syncUnavailable = () => disposed || loading() || !!inFlight;

  const sync = async () => {
    if (checking || syncUnavailable()) return;
    checking = true;
    const current = document();

    try {
      const next = await request("read");

      if (!disposed) setReadError("");

      if (syncUnavailable() || document() !== current) return;

      receiveUpdate(next, current);
    } catch (reason) {
      if (!disposed) setReadError(reason instanceof Error ? reason.message : String(reason));
    } finally { checking = false; }
  };

  const retry = async () => {
    if (!document()) { await load();

      return; }

    if (readError()) await sync();

    if (dirty()) await save();
  };

  const resume = () => { if (!window.document.hidden) void sync(); };

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!pendingWork()) return;
    event.preventDefault();
    event.returnValue = "";
    void save();
  };

  onMount(() => { void load(); });
  const updates = setInterval(() => void sync(), 1000);
  window.addEventListener("focus", resume);
  window.document.addEventListener("visibilitychange", resume);
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { disposed = true; clearInterval(updates); window.removeEventListener("focus", resume); window.document.removeEventListener("visibilitychange", resume); window.removeEventListener("beforeunload", beforeUnload); void save(); });

  return { content, loading, saving, error, ready: () => !!document(), dirty, edit, save, retry };
}
