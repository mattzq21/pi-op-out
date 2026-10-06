import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { z } from "zod";
import { invoke } from "../../lib/platform";
import { required } from "../../lib/required";
import { registerPluginFlush } from "../lifecycle";
import { createDependencyEffect } from "../../lib/solid";
import { ownershipSchema } from "../ownership";

const noteOwnershipSchema = ownershipSchema.extend({ token: z.string().nullable() });

const noteSchema = z.object({ content: z.string(), version: z.string(), ownership: noteOwnershipSchema });

type NoteDocument = z.infer<typeof noteSchema>;

type NoteOwnership = z.infer<typeof noteOwnershipSchema>;

const noOwnership: NoteOwnership = { owned: false, available: false, token: null };

export interface ChatNoteTarget { sessionId: string; hostId: string; }

export function useChatNote(target: ChatNoteTarget, visible: Accessor<boolean>) {
  const [document, setDocument] = createSignal<NoteDocument>();
  const [ownership, setOwnership] = createSignal<NoteOwnership>(noOwnership);
  const [content, setContent] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [leaseValid, setLeaseValid] = createSignal(false);
  const [flushing, setFlushing] = createSignal(false);
  const [unconfirmed, setUnconfirmed] = createSignal<{ content: string; token: string }>();
  const [readError, setReadError] = createSignal("");
  const [saveError, setSaveError] = createSignal("");
  const error = () => readError() || saveError();
  const leaseId = crypto.randomUUID();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  let inFlight: Promise<boolean> | undefined;
  let operations = Promise.resolve();
  let checking = false;
  const dirty = () => !!document() && (!!unconfirmed() || content() !== document()?.content);
  const editable = () => visible() && !loading() && !flushing() && leaseValid() && ownership().owned;
  const pendingWork = () => !!inFlight || dirty();

  try { localStorage.removeItem("piop-chat-note:" + JSON.stringify([target.hostId, target.sessionId])); } catch { }

  const call = (action: string, fields: Record<string, string> = {}) => {
    const result = operations.then(() => invoke("plugin_call", { hostId: target.hostId, pluginId: "markdown", request: { sessionId: target.sessionId, leaseId, action, ...fields } }, noteSchema));
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
    setLeaseValid(false); setUnconfirmed(undefined);
    setContent(document()?.content ?? "");
  };

  const updateOwnership = (value: NoteOwnership) => {
    clearTimeout(leaseTimer);
    setOwnership(value);
    setLeaseValid(value.owned);

    if (value.owned && !disposed) leaseTimer = setTimeout(() => { setLeaseValid(false); void sync(); }, 25000);
  };

  const selectDocument = (next: NoteDocument) => {
    setDocument(next);
    setContent(next.content);
    updateOwnership(next.ownership);
  };

  const load = async (action: string) => {
    relinquish();
    const current = generation;
    setLoading(true); setReadError(""); setSaveError("");

    try {
      const next = await request(action);

      if (!disposed && current === generation) selectDocument(next);
    } catch (reason) { if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed && current === generation) setLoading(false); }
  };

  const refreshAfterFailure = async () => {
    const current = generation;

    try {
      const next = await readCurrent();

      if (disposed || current !== generation) return;
      setReadError("");
      receiveUpdate(next);

      if (!next.ownership.owned) setSaveError("");
    } catch (reason) { if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const drain = async () => {
    const current = generation;
    setSaving(true);

    try {
      if (!leaseValid()) await refreshAfterFailure();

      if (!leaseValid()) return !dirty();

      while (dirty() && ownership().owned) {
        const note = required(document());
        const body = content();
        const leaseToken = required(ownership().token);
        setUnconfirmed({ content: body, token: leaseToken });
        const saved = await request("save", { content: body, version: note.version, leaseToken });

        if (current !== generation) return true;

        if (saved.ownership.token !== leaseToken) { relinquish(); selectDocument(saved);

        return true; }

        setUnconfirmed(undefined); setDocument(saved); updateOwnership(saved.ownership);
      }

      setSaveError("");

      return !dirty();
    } catch (reason) {
      if (current !== generation) return true;
      setLeaseValid(false);
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      await refreshAfterFailure();

      return !dirty();
    } finally { setSaving(false); }
  };

  const save = (): Promise<boolean> => {
    if (inFlight) return inFlight;

    if (!dirty()) return Promise.resolve(true);

    if (!ownership().owned) { relinquish();

    return Promise.resolve(true); }

    inFlight = drain().finally(() => { inFlight = undefined;

    if (!ownership().owned) void sync(); });

    return inFlight;
  };

  const edit = (body: string) => {
    if (!document() || !editable()) return;
    setContent(body);
    void save();
  };

  onCleanup(registerPluginFlush(target.hostId, async () => {
    setFlushing(true);

    try {
      if (pendingWork() && !await save()) throw new Error("The note could not be saved. Retry saving before disconnecting or restarting plugins.");
    } finally { setFlushing(false); }
  }));

  const confirmedSave = (next: NoteDocument) => unconfirmed()?.token === next.ownership.token && unconfirmed()?.content === next.content;

  const receiveUpdate = (next: NoteDocument) => {
    if (next.ownership.token !== ownership().token || next.version !== document()?.version && !confirmedSave(next)) {
      relinquish(); selectDocument(next); setSaveError("");

      return;
    }

    setUnconfirmed(undefined); setDocument(next); updateOwnership(next.ownership);
  };

  const syncUnavailable = () => disposed || loading() || !!inFlight;

  const readCurrent = () => {
    const leaseToken = ownership().token;

    return (visible() || dirty()) && leaseToken ? request("renew", { leaseToken }) : request("read");
  };

  const sync = async () => {
    if (checking || syncUnavailable()) return;
    checking = true;
    const current = generation;
    const note = document();

    try {
      const next = await readCurrent();

      if (current !== generation || syncUnavailable() || document() !== note) return;
      setReadError(""); receiveUpdate(next);
    } catch (reason) {
      if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason));
    } finally { checking = false; }
  };

  const release = async () => {
    if (!ownership().owned && !inFlight) return;

    if (!await save()) return;

    if (!disposed && visible()) return;
    const leaseToken = ownership().token;
    relinquish();
    const current = generation;

    if (!leaseToken) return;

    try {
      const next = await call("release", { leaseToken });

      if (!disposed && current === generation) selectDocument(next);
    } catch { }
  };

  const takeControl = () => load("takeover");

  const retry = async () => {
    if (!document()) { await load("read");

    return; }

    await sync();

    if (dirty()) await save();
  };

  const resume = () => { if (!window.document.hidden) void sync(); };

  const show = async () => {
    if (!await save()) return;

    if (visible() && !disposed && !loading()) await load("claim");
  };

  createDependencyEffect(() => { if (visible()) void show(); else void release(); }, () => [visible()]);

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

  return { content, loading, saving, error, ready: () => !!document(), editable, edit, save, retry, takeControl };
}
