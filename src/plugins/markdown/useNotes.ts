import { batch, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { z } from "zod";
import { captureDaemonTransport } from "../../lib/platform";
import { required } from "../../lib/required";
import { registerPluginFlush } from "../lifecycle";
import { createDependencyEffect } from "../../lib/solid";
import { ownershipSchema } from "../ownership";
import { legacyNoteDraftCurrent, readLegacyNoteDraft, retireLegacyNoteDraft, type LegacyNoteDraft } from "./legacyNoteDrafts";

const noteOwnershipSchema = ownershipSchema.extend({ token: z.string().nullable() });

const noteSchema = z.object({ content: z.string(), version: z.string(), ownership: noteOwnershipSchema, deleted: z.boolean().default(false), disabled: z.boolean().default(false) });

type NoteDocument = z.infer<typeof noteSchema>;

type NoteOwnership = z.infer<typeof noteOwnershipSchema>;

const noOwnership: NoteOwnership = { owned: false, available: false, token: null };

export interface ChatNoteTarget { sessionId: string; hostId: string; }

export function useChatNote(target: ChatNoteTarget, visible: Accessor<boolean>, transport = captureDaemonTransport()) {
  const [document, setDocument] = createSignal<NoteDocument>();
  const [ownership, setOwnership] = createSignal<NoteOwnership>(noOwnership);
  const [content, setContent] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [releasing, setReleasing] = createSignal(false);
  const [leaseValid, setLeaseValid] = createSignal(false);
  const [flushing, setFlushing] = createSignal(false);
  const [unconfirmed, setUnconfirmed] = createSignal<string>();
  const [readError, setReadError] = createSignal("");
  const [saveError, setSaveError] = createSignal("");
  const [conflict, setConflict] = createSignal(false);
  const [restoredLegacyDraft, setRestoredLegacyDraft] = createSignal<LegacyNoteDraft>();
  const storedLegacyDraft = createMemo(() => readLegacyNoteDraft(target));
  const legacyDraft = () => storedLegacyDraft()?.stored === restoredLegacyDraft()?.stored ? undefined : storedLegacyDraft();
  const error = () => readError() || saveError();
  const leaseId = crypto.randomUUID();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let visibilityRevision = 0;
  let disposed = false;
  let inFlight: Promise<boolean> | undefined;
  let retirement: Promise<void> | undefined;
  let acquisition: Promise<void> | undefined;
  let operations = Promise.resolve();
  let checking = false;
  const dirty = () => !!document() && (unconfirmed() !== undefined || content() !== document()?.content);
  const editable = () => visible() && !loading() && !flushing() && !releasing() && !conflict() && leaseValid() && ownership().owned;
  const pendingWork = () => !!inFlight || dirty();

  const call = (action: string, fields: Record<string, string> = {}) => {
    const result = operations.then(() => transport.invoke("plugin_call", { hostId: target.hostId, pluginId: "markdown", request: { sessionId: target.sessionId, leaseId, action, ...fields } }, noteSchema));
    operations = result.then(() => undefined, () => undefined);

    return result;
  };

  const request = async (action: string, fields: Record<string, string> = {}) => {
    const result = await call(action, fields);

    if ((action === "claim" || action === "takeover") && (disposed || !visible()) && result.ownership.token) {
      return call("release", { leaseToken: result.ownership.token });
    }

    return result;
  };

  const relinquish = () => {
    generation++;
    clearTimeout(leaseTimer);
    setOwnership(noOwnership);
    setLeaseValid(false);
  };

  const updateOwnership = (value: NoteOwnership) => {
    clearTimeout(leaseTimer);
    setOwnership(value);
    setLeaseValid(value.owned);

    if (value.owned && !disposed) leaseTimer = setTimeout(() => { setLeaseValid(false); void sync(); }, 25000);
  };

  const displacesDraft = (next: NoteDocument) => dirty() && (next.deleted || content() !== next.content
    && (next.disabled || next.version !== document()?.version && !confirmedSave(next)));

  const reconcileUnconfirmed = (next: NoteDocument, unsaved: boolean) => {
    if (unsaved && next.deleted) setUnconfirmed(content());
    else if (!unsaved || confirmedSave(next) || content() === next.content) setUnconfirmed(undefined);
  };

  const retireRestoredDraft = () => {
    const draft = restoredLegacyDraft();

    if (!draft) return;
    setRestoredLegacyDraft(undefined);
    retireLegacyNoteDraft(draft);
  };

  const confirmRestoredDraft = (next: NoteDocument) => {
    if (!next.deleted && (next.content === restoredLegacyDraft()?.content || !dirty())) retireRestoredDraft();
  };

  const selectDocument = (next: NoteDocument) => batch(() => {
    const unsaved = dirty();
    const displaced = displacesDraft(next);
    setDocument(next);

    if (!unsaved) setContent(next.content);

    reconcileUnconfirmed(next, unsaved);
    updateOwnership(next.ownership);

    if (displaced) setConflict(true);

    if (!dirty()) { setConflict(false); setSaveError(""); }
    else if (!next.ownership.owned && !saveError()) setSaveError("Your unsaved edits are retained. Take control of the note to save them.");
    confirmRestoredDraft(next);
  });

  const loadDocument = async (action: string) => {
    relinquish();
    const current = generation;
    setLoading(true); setReadError("");

    if (!dirty()) setSaveError("");

    try {
      const next = await request(action);

      if (!disposed && current === generation) selectDocument(next);
    } catch (reason) { if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed && current === generation) setLoading(false); }
  };

  const load = (action: string) => {
    const pending = loadDocument(action).finally(() => { if (acquisition === pending) acquisition = undefined; });
    acquisition = pending;

    return pending;
  };

  const refreshAfterFailure = async () => {
    const current = generation;

    try {
      const next = await readCurrent();

      if (disposed || current !== generation) return;
      setReadError("");
      receiveUpdate(next);
    } catch (reason) { if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const canDrain = async () => {
    if (conflict()) return false;

    if (!leaseValid()) await refreshAfterFailure();

    return leaseValid() && !conflict() && ownership().owned;
  };

  const persistDraft = async (current: number) => {
    if (current !== generation) return false;
    const note = required(document());
    const body = content();
    const leaseToken = required(ownership().token);
    setUnconfirmed(body);
    const saved = await request("save", { content: body, version: note.version, leaseToken });

    if (current !== generation) return false;

    if (saved.ownership.token !== leaseToken) relinquish();
    selectDocument(saved);

    return saved.ownership.token === leaseToken;
  };

  const drain = async () => {
    const current = generation;
    setSaving(true);

    try {
      if (!await canDrain()) return !dirty();

      while (dirty() && ownership().owned && !conflict()) {
        if (!await persistDraft(current)) return !dirty();
      }

      if (!dirty()) setSaveError("");

      return !dirty();
    } catch (reason) {
      if (current !== generation) return !dirty();
      setLeaseValid(false);
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      await refreshAfterFailure();

      return !dirty();
    } finally { setSaving(false); }
  };

  const save = (): Promise<boolean> => {
    if (inFlight) return inFlight;

    if (!dirty()) return Promise.resolve(true);

    if (conflict()) return Promise.resolve(false);

    if (!ownership().owned) { setSaveError("Your unsaved edits are retained. Take control of the note to save them.");

    return Promise.resolve(false); }

    inFlight = drain().finally(() => { inFlight = undefined;

    if (!ownership().owned) void sync(); });

    return inFlight;
  };

  const edit = (body: string) => {
    if (!document() || !editable()) return;
    setContent(body);
    void save();
  };

  onCleanup(registerPluginFlush(target.hostId, async enabled => {
    if (!transport.active()) return;
    setFlushing(true);

    try {
      if (pendingWork() && !await save() && !(document()?.disabled && enabled?.includes("markdown"))) throw new Error("The note could not be saved. Retry saving, or recover unavailable notes in plugin settings, before disconnecting or restarting plugins.");
    } finally { setFlushing(false); }
  }));

  const confirmedSave = (next: NoteDocument) => !next.deleted && unconfirmed() === next.content;

  const receiveUpdate = selectDocument;

  const syncUnavailable = () => disposed || loading() || releasing() || !!inFlight || document()?.deleted;

  const readCurrent = () => {
    const leaseToken = ownership().token;

    return (visible() || dirty()) && leaseToken ? request("renew", { leaseToken }) : request("read");
  };

  const releaseIfHidden = () => { if (!visible() && !dirty()) void release(); };

  const sync = async () => {
    if (checking || syncUnavailable()) return;
    checking = true;
    const current = generation;
    const note = document();

    try {
      const next = await readCurrent();

      if (current !== generation || syncUnavailable() || document() !== note) return;
      setReadError(""); receiveUpdate(next);
      releaseIfHidden();
    } catch (reason) {
      if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason));
    } finally { checking = false; }
  };

  const releaseOwned = async () => {
    if (!await save()) return;

    if (!disposed && visible()) return;
    const leaseToken = ownership().token;
    const current = generation;

    if (!leaseToken) return;
    setLeaseValid(false);

    try {
      const next = await call("release", { leaseToken });

      if (!disposed && current === generation) { relinquish(); selectDocument(next); }
    } catch { }
  };

  const release = (): Promise<void> => {
    if (retirement) return retirement;

    if (!ownership().owned && !inFlight) return Promise.resolve();
    setReleasing(true);
    retirement = releaseOwned().finally(() => { retirement = undefined; setReleasing(false); });

    return retirement;
  };

  const takeControl = () => load("takeover");

  const retry = async () => {
    if (!document()) { await load("read");

    return; }

    await sync();

    if (dirty()) await save();
  };

  const saveEdits = () => {
    if (!document() || document()?.deleted || document()?.disabled || !ownership().owned) return Promise.resolve(false);
    setConflict(false);

    return save();
  };

  const useSaved = () => {
    if (loading() || saving()) return;
    batch(() => {
      retireRestoredDraft();
      setUnconfirmed(undefined); setContent(document()?.content ?? ""); setConflict(false); setSaveError("");
    });
  };

  const restoreLegacyDraft = () => {
    const draft = legacyDraft();

    if (!draft || draft.content === undefined || !document() || loading() || saving() || dirty() || !transport.active()) return;

    if (!legacyNoteDraftCurrent(draft)) { setSaveError("The older draft changed or could not be read. Review it again before restoring it.");

    return; }

    const body = draft.content;

    batch(() => {
      setRestoredLegacyDraft(draft);
      setContent(body); setUnconfirmed(body); setConflict(true);
    });
  };

  const resume = () => { if (!window.document.hidden) void sync(); };

  const settleOwnership = async () => {
    while (acquisition || retirement) await Promise.all([acquisition, retirement]);
  };

  const show = async (current: number) => {
    await settleOwnership();

    if (!await save()) return;
    await settleOwnership();

    if (current === visibilityRevision && visible() && !disposed && !document()?.deleted) await load("claim");
  };

  createDependencyEffect(() => {
    const current = ++visibilityRevision;

    if (visible()) void show(current); else void release();
  }, () => [visible()]);

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!pendingWork()) return;
    event.preventDefault();
    event.returnValue = "";
    void save();
  };

  onMount(() => { void load(visible() ? "claim" : "read"); });
  const updates = setInterval(() => void sync(), 1000);
  window.addEventListener("focus", resume);
  window.document.addEventListener("visibilitychange", resume);
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { disposed = true; clearTimeout(leaseTimer); clearInterval(updates); window.removeEventListener("focus", resume); window.document.removeEventListener("visibilitychange", resume); window.removeEventListener("beforeunload", beforeUnload); void release(); });

  const ready = () => !!document() && !document()?.deleted && !document()?.disabled;
  const pending = () => loading() || saving() || releasing() || dirty() || ownership().owned;

  return { content, loading, saving, dirty, error, conflict, legacyDraft, restoreLegacyDraft, savedVersion: () => document()?.version, savedContent: () => document()?.content ?? "", owned: () => ownership().owned,
    deleted: () => document()?.deleted, disabled: () => document()?.disabled, ready, pending, editable, edit, save, retry, takeControl, saveEdits, useSaved };
}
