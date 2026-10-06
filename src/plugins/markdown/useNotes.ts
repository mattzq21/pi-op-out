import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { z } from "zod";
import { invoke } from "../../lib/platform";
import { required } from "../../lib/required";
import { registerPluginFlush } from "../lifecycle";
import { createDependencyEffect } from "../../lib/solid";
import { ownershipSchema, type PluginOwnership } from "../ownership";

const draftSchema = z.object({ content: z.string(), version: z.string() });

const noteSchema = draftSchema.extend({ ownership: ownershipSchema });

type NoteDocument = z.infer<typeof noteSchema>;

export interface ChatNoteTarget { sessionId: string; hostId: string; }

function readDraft(key: string) {
  try {
    const result = draftSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));

    if (result.success) return result.data;
  } catch { }
}

export function useChatNote(target: ChatNoteTarget, visible: Accessor<boolean>) {
  const [document, setDocument] = createSignal<NoteDocument>();
  const [remote, setRemote] = createSignal<NoteDocument>();
  const [ownership, setOwnership] = createSignal<PluginOwnership>({ owned: false, available: true });
  const [content, setContent] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [unconfirmed, setUnconfirmed] = createSignal(false);
  const [readError, setReadError] = createSignal("");
  const [saveError, setSaveError] = createSignal("");
  const error = () => readError() || saveError();
  const draftKey = "piop-chat-note:" + JSON.stringify([target.hostId, target.sessionId]);
  const draftOwner = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let draftRevision: string | null | undefined;

  try {
    const stored = localStorage.getItem(draftKey);
    const cached = draftSchema.safeParse(JSON.parse(stored ?? "null"));
    draftRevision = stored;

    if (cached.success) {
      const claimed = JSON.stringify({ ...cached.data, owner: draftOwner });
      localStorage.setItem(draftKey, claimed);
      draftRevision = claimed;
    }
  } catch { }

  const dirty = () => !!document() && (unconfirmed() || content() !== document()?.content);
  const conflict = () => dirty() && !!remote() && remote()?.version !== document()?.version;
  const editable = () => visible() && ownership().owned;
  let disposed = false;
  let inFlight: Promise<boolean> | undefined;
  const pendingWork = () => !!inFlight || dirty();
  let checking = false;
  const call = (action: string, fields: Record<string, string> = {}) => invoke("plugin_call", { hostId: target.hostId, pluginId: "markdown", request: { sessionId: target.sessionId, leaseId, action, ...fields } }, noteSchema);

  const request = async (action: string, fields: Record<string, string> = {}) => {
    const result = await call(action, fields);

    if (action === "claim" && (disposed || !visible())) {
      await call("release");

      return { ...result, ownership: { owned: false, available: true } };
    }

    return result;
  };

  const updateOwnership = (value: PluginOwnership) => {
    clearTimeout(leaseTimer);
    setOwnership(value);

    if (value.owned && !disposed) leaseTimer = setTimeout(() => setOwnership({ owned: false, available: false }), 25000);
  };

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
    setRemote(next); updateOwnership(next.ownership);
    setUnconfirmed(false);
    setDocument(draft ? { ...next, version: draft.version } : next);
    setContent(draft?.content ?? next.content);

    if (draft) setSaveError("Recovered your unsaved note. Save it to continue.");
    else clearDraft();
  };

  const load = async (recover = true) => {
    setLoading(true);
    setReadError("");

    try {
      const next = await request(visible() ? "claim" : "read");

      if (disposed) return;
      selectDocument(next, recover);
    } catch (reason) { if (!disposed) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setLoading(false); }
  };

  const drain = async () => {
    setSaving(true);

    try {
      while (dirty()) {
        if (!ownership().owned) throw new Error("This note is read-only while another client owns it. Your draft has been kept.");

        if (conflict()) throw new Error("The saved note changed. Choose which version to keep.");
        const current = required(document());
        const body = content();
        setUnconfirmed(true);
        const saved = await request("save", { content: body, version: current.version });

        if (saved.content !== body) throw new Error("The note was not saved. Your draft has been kept.");
        setDocument(saved);
        setUnconfirmed(false);
        setRemote(saved); updateOwnership(saved.ownership);

        if (!dirty()) clearDraft();
        else cache(saved, content());
      }

      setSaveError("");

      return true;
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : String(reason));

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

    if (!current || loading() || !editable()) return;
    setContent(body);
    cache(current, body, true);
    void save();
  };

  onCleanup(registerPluginFlush(target.hostId, async () => {
    if (pendingWork() && !await save()) throw new Error("The note could not be saved. Retry saving it before restarting plugins.");
  }));

  const receiveUpdate = (next: NoteDocument, current: NoteDocument | undefined) => {
    setRemote(next); updateOwnership(next.ownership);

    if (!current) { selectDocument(next, true);

      return; }

    if (next.content === content()) { selectDocument(next, false); setSaveError("");

    return; }

    if (next.version === current.version) return;

    if (dirty()) { setSaveError("The saved note changed. Your draft has been kept.");

    return; }

    selectDocument(next, false);
    setSaveError("");
  };

  const syncUnavailable = () => disposed || loading() || !!inFlight;

  const sync = async () => {
    if (checking || syncUnavailable()) return;
    checking = true;
    const current = document();

    try {
      const next = await request(visible() ? "claim" : "read");

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

    await sync();

    if (dirty()) await save();
  };

  const resume = () => { if (!window.document.hidden) void sync(); };

  const useSaved = () => {
    const latest = remote();

    if (latest) { selectDocument(latest, false); setSaveError(""); }
  };

  const keepDraft = async () => {
    await sync();
    const latest = remote();

    if (!latest || !ownership().owned) return;
    setDocument(latest);
    await save();
  };

  const release = async () => {
    await save();

    if (!disposed && visible()) return;

    try { const next = await call("release"); updateOwnership(next.ownership); }
    catch { updateOwnership({ owned: false, available: false }); }
  };

  createDependencyEffect(() => { if (visible()) void sync(); else void release(); }, () => [visible()]);

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
  onCleanup(() => { disposed = true; clearTimeout(leaseTimer); clearInterval(updates); window.removeEventListener("focus", resume); window.document.removeEventListener("visibilitychange", resume); window.removeEventListener("beforeunload", beforeUnload); void release(); });

  return { content, loading, saving, error, ready: () => !!document(), dirty, editable, conflict, ownership, edit, save, retry, useSaved, keepDraft };
}
