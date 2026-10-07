import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { z } from "zod";
import { captureDaemonTransport } from "../../lib/platform";
import { required } from "../../lib/required";
import { registerPluginFlush } from "../lifecycle";
import { createDependencyEffect } from "../../lib/solid";
import { ownershipSchema } from "../ownership";
import { createNoteRecovery, type NoteRecovery } from "./noteRecovery";

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
  const [local, setLocal] = createSignal<NoteRecovery>();
  const [recoveries, setRecoveries] = createSignal<NoteRecovery[]>([]);
  const [storedRevision, setStoredRevision] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [releasing, setReleasing] = createSignal(false);
  const [leaseValid, setLeaseValid] = createSignal(false);
  const [flushing, setFlushing] = createSignal(false);
  const [unconfirmed, setUnconfirmed] = createSignal<string>();
  const [readError, setReadError] = createSignal("");
  const [saveError, setSaveError] = createSignal("");
  const [recoveryError, setRecoveryError] = createSignal("");
  const [recoveryReadError, setRecoveryReadError] = createSignal("");
  const [storagePending, setStoragePending] = createSignal(0);
  const error = () => readError() || saveError() || recoveryError() || recoveryReadError();
  const leaseId = crypto.randomUUID();
  const recovery = createNoteRecovery(transport.identity, target.hostId, target.sessionId, leaseId);
  const [recoveredSource, setRecoveredSource] = createSignal<NoteRecovery>();
  let recoveryReady: Promise<void> | undefined;
  let storageOperations = Promise.resolve();
  const pendingRemovals = new Map<string, NoteRecovery>();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let visibilityRevision = 0;
  let disposed = false;
  let inFlight: Promise<boolean> | undefined;
  let retirement: Promise<void> | undefined;
  let acquisition: Promise<void> | undefined;
  let operations = Promise.resolve();
  let checking = false;
  const dirty = () => !!local();
  const conflict = () => !!local() && !!document() && local()?.baseVersion !== document()?.version;
  const editable = () => visible() && !loading() && !flushing() && !releasing() && leaseValid() && ownership().owned;
  const pendingWork = () => !!inFlight || dirty() || !!recoveryError() || storagePending() > 0;
  const durable = () => !local() || storedRevision() === local()?.revision;

  const store = (operation: () => Promise<void>) => {
    setStoragePending(value => value + 1);
    const result = storageOperations.then(operation);
    storageOperations = result.then(() => {
      if (durable() && !pendingRemovals.size) setRecoveryError("");
    }, reason => { setRecoveryError("Could not preserve the note recovery copy. " + String(reason)); }).finally(() => setStoragePending(value => value - 1));

    return storageOperations;
  };

  const persist = (value: NoteRecovery) => store(async () => {
    await recovery.save(value);
    setStoredRevision(value.revision);
  });

  const removeRecovery = (value: NoteRecovery) => {
    pendingRemovals.set(value.revision, value);

    return store(async () => {
      await recovery.remove(value);
      pendingRemovals.delete(value.revision);
      setRecoveries(items => items.filter(item => item.id !== value.id || item.revision !== value.revision));
    });
  };

  const matchingCopy = (left: NoteRecovery, right: NoteRecovery) => left.content === right.content && left.baseVersion === right.baseVersion;

  const discardRecovery = async (value: NoteRecovery) => {
    for (const copy of recoveries()) {
      if (matchingCopy(copy, value)) await removeRecovery(copy);
    }
  };

  const forgetLocal = (discard = true) => {
    const value = local();
    const source = recoveredSource();
    setLocal(undefined); setUnconfirmed(undefined); setStoredRevision(undefined); setRecoveredSource(undefined);

    if (value) void removeRecovery(value);

    if (discard && source) void discardRecovery(source);
  };

  const acknowledgeCopies = (body: string) => {
    for (const copy of recoveries()) {
      if (copy.content === body && !pendingRemovals.has(copy.revision)) void removeRecovery(copy);
    }
  };

  const restore = (value: NoteRecovery) => {
    if (dirty() || inFlight) return;
    setRecoveredSource(value);
    const next = recovery.create(value.content, value.baseVersion);
    setLocal(next); setContent(next.content);
    void persist(next);
  };

  const loadRecovery = async () => {
    try {
      const { copies, warnings } = await recovery.load();
      const values = copies.filter(value => value.id !== leaseId);
      setRecoveries(values);
      setRecoveryReadError(warnings.join(" "));

      if (values[0]) restore(values[0]);
    } catch (reason) { setRecoveryReadError("Could not restore saved note edits. " + String(reason)); }
  };

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
    setOwnership(noOwnership); setLeaseValid(false);
  };

  const updateOwnership = (value: NoteOwnership) => {
    clearTimeout(leaseTimer);
    setOwnership(value); setLeaseValid(value.owned);

    if (value.owned && !disposed) leaseTimer = setTimeout(() => { setLeaseValid(false); void sync(); }, 25000);
  };

  const receiveUpdate = (next: NoteDocument) => {
    const edit = local();

    if (edit && edit.content === next.content && !next.deleted) forgetLocal(false);
    else if (edit && unconfirmed() === next.content && !next.deleted) {
      const rebased = recovery.create(edit.content, next.version);
      setLocal(rebased); setUnconfirmed(undefined);
      void persist(rebased);
    }

    setDocument(next); updateOwnership(next.ownership);

    if (!next.deleted) acknowledgeCopies(next.content);

    if (!dirty()) setContent(next.content);
  };

  const loadDocument = async (action: string) => {
    relinquish();
    const current = generation;
    setLoading(true); setReadError("");

    try {
      recoveryReady ??= loadRecovery();
      await recoveryReady;
      const next = await request(action);

      if (!disposed && current === generation) receiveUpdate(next);
    } catch (reason) { if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed && current === generation) setLoading(false); }
  };

  const load = (action: string) => {
    const pending = loadDocument(action).finally(() => { if (acquisition === pending) acquisition = undefined; });
    acquisition = pending;

    return pending;
  };

  const readCurrent = () => {
    const leaseToken = ownership().token;

    return visible() && leaseToken ? request("renew", { leaseToken }) : request("read");
  };

  const refreshAfterFailure = async () => {
    const current = generation;

    try {
      const next = await readCurrent();

      if (disposed || current !== generation) return;
      setReadError(""); receiveUpdate(next);
    } catch (reason) { if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const canSave = () => leaseValid() && ownership().owned && !conflict() && !document()?.deleted && !document()?.disabled;

  const drainEdits = async (current: number) => {
    while (dirty() && canSave()) {
      const edit = required(local());
      await storageOperations;

      if (!canSave()) return;

      if (local()?.revision !== edit.revision) continue;
      const note = required(document());
      const leaseToken = required(ownership().token);
      setUnconfirmed(edit.content);
      const saved = await request("save", { content: edit.content, version: note.version, leaseToken });

      if (current !== generation) return;
      receiveUpdate(saved);
    }
  };

  const drain = async () => {
    const current = generation;
    setSaving(true);

    try {
      await storageOperations;

      if (!leaseValid()) await refreshAfterFailure();

      await drainEdits(current);

      if (!dirty()) setSaveError("");

      return !dirty();
    } catch (reason) {
      if (current !== generation) return !dirty();
      setLeaseValid(false);
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      await refreshAfterFailure();

      if (!dirty()) setSaveError("");

      return !dirty();
    } finally { setSaving(false); }
  };

  const save = (): Promise<boolean> => {
    if (inFlight) return inFlight;

    if (!dirty()) return Promise.resolve(true);

    if (!ownership().owned || conflict()) return Promise.resolve(false);
    inFlight = drain().finally(() => { inFlight = undefined; });

    return inFlight;
  };

  const edit = (body: string) => {
    const note = document();

    if (!note || !editable()) return;
    const next = recovery.create(body, local()?.baseVersion ?? note.version);
    setContent(body); setLocal(next);
    void persist(next);
    void save();
  };

  const useSaved = () => {
    if (inFlight || !document()) return;
    forgetLocal(); setContent(required(document()).content); setSaveError("");
  };

  const useLocal = async () => {
    if (!editable() || !local() || !document()) return;
    const next = recovery.create(content(), required(document()).version);
    setLocal(next); setUnconfirmed(undefined);
    await persist(next);
    await save();
  };

  onCleanup(registerPluginFlush(target.hostId, async () => {
    if (!transport.active()) return;
    setFlushing(true);

    try {
      if (pendingWork() && !await save()) throw new Error("The note has unsaved edits. Resolve its recovery copy before disconnecting or restarting plugins.");
      await storageOperations;

      if (recoveryError()) throw new Error(recoveryError());
    } finally { setFlushing(false); }
  }));

  const syncUnavailable = () => disposed || loading() || releasing() || !!inFlight || document()?.deleted;
  const releaseIfHidden = () => { if (!visible()) void release(); };

  const sync = async () => {
    if (checking || syncUnavailable()) return;
    checking = true;
    const current = generation;
    const note = document();

    try {
      const next = await readCurrent();

      if (current !== generation || syncUnavailable() || document() !== note) return;
      setReadError(""); receiveUpdate(next); releaseIfHidden();
    } catch (reason) {
      if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason));
    } finally { checking = false; }
  };

  const releaseOwned = async () => {
    await save();
    await storageOperations;

    if (!durable() || !disposed && visible()) return;
    const leaseToken = ownership().token;
    const current = generation;

    if (!leaseToken) return;
    setLeaseValid(false);

    try {
      const next = await call("release", { leaseToken });

      if (!disposed && current === generation) { relinquish(); receiveUpdate(next); }
    } catch { }
  };

  const release = (): Promise<void> => {
    if (retirement) return retirement;

    if (!ownership().owned && !inFlight) return Promise.resolve();
    setReleasing(true);
    retirement = releaseOwned().finally(() => { retirement = undefined; setReleasing(false); });

    return retirement;
  };

  const takeControl = async () => { await inFlight; await load("takeover"); };

  const retry = async () => {
    if (local()) await persist(required(local()));

    for (const value of [...pendingRemovals.values()]) await removeRecovery(value);

    if (recoveryReadError()) await loadRecovery();

    if (!document()) { await load("read");

    return; }

    await sync();

    if (dirty()) await save();
  };

  const resume = () => { if (!window.document.hidden) void sync(); };

  const settleOwnership = async () => {
    while (acquisition || retirement) await Promise.all([acquisition, retirement]);
  };

  const show = async (current: number) => {
    await settleOwnership();
    await save();
    await settleOwnership();

    if (current === visibilityRevision && visible() && !disposed && !document()?.deleted) await load("claim");
  };

  createDependencyEffect(() => {
    const current = ++visibilityRevision;

    if (visible()) void show(current); else void release();
  }, () => [visible()]);

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!pendingWork()) return;
    event.preventDefault(); event.returnValue = "";
    void save();
  };

  onMount(() => { void load(visible() ? "claim" : "read"); });
  const updates = setInterval(() => void sync(), 1000);
  window.addEventListener("focus", resume);
  window.document.addEventListener("visibilitychange", resume);
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { disposed = true; clearTimeout(leaseTimer); clearInterval(updates); window.removeEventListener("focus", resume); window.document.removeEventListener("visibilitychange", resume); window.removeEventListener("beforeunload", beforeUnload); void release(); });

  const ready = () => !!document() && !document()?.deleted && !document()?.disabled;
  const pending = () => loading() || saving() || releasing() || !durable() || storagePending() > 0 || !!recoveryError() || ownership().owned;

  const recoveryCopies = () => {
    const source = recoveredSource();
    const unique: NoteRecovery[] = [];

    for (const value of recoveries()) {
      if (source && matchingCopy(value, source)) continue;

      if (!unique.some(copy => matchingCopy(copy, value))) unique.push(value);
    }

    return unique;
  };

  return { content, loading, saving, error, dirty, conflict, durable, recoveries: recoveryCopies, restore, discardRecovery, useSaved, useLocal, savedContent: () => document()?.content ?? "", deleted: () => document()?.deleted, disabled: () => document()?.disabled, ready, pending, editable, edit, save, retry, takeControl };
}
