import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { z } from "zod";
import { captureDaemonTransport, listen, type UnlistenFn } from "../../lib/platform";
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
  const [releaseError, setReleaseError] = createSignal("");
  const [storagePending, setStoragePending] = createSignal(0);
  const error = () => subscriptionError() || readError() || saveError() || recoveryError() || recoveryReadError() || releaseError();
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
  /** Lease token of a release that failed. It is sent again when the connection returns or on Retry. */
  let pendingRelease: string | undefined;
  const [syncPending, setSyncPending] = createSignal(false);
  const [subscriptionError, setSubscriptionError] = createSignal("");
  const dirty = () => !!local();
  const conflict = () => !!local() && !!document() && (local()?.baseVersion !== document()?.version);
  const editable = () => visible() && !loading() && !flushing() && !releasing() && !conflict() && leaseValid() && ownership().owned;
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

  /** The newest copy that waits for its write to start. Older waiting copies are replaced, so at most one write waits. */
  let persistQueued: NoteRecovery | undefined;
  let persistPending: Promise<void> | undefined;

  const persist = (value: NoteRecovery) => {
    const waiting = persistQueued !== undefined;
    persistQueued = value;

    if (waiting) return required(persistPending);

    persistPending = store(async () => {
      const next = required(persistQueued);
      persistQueued = undefined; persistPending = undefined;
      await recovery.save(next);
      setStoredRevision(next.revision);
    });

    return persistPending;
  };

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

    if (!loading()) void save();
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

  const reconcileLocal = (next: NoteDocument) => {
    const edit = local();

    if (edit && edit.content === next.content && !next.deleted) forgetLocal();
    else if (edit && unconfirmed() === next.content && !next.deleted) {
      const rebased = recovery.create(edit.content, next.version);
      setLocal(rebased); setUnconfirmed(undefined);
      void persist(rebased);
    }
  };

  const receiveUpdate = (next: NoteDocument) => {
    reconcileLocal(next);
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

      if (!disposed && current === generation) {
        receiveUpdate(next);

        if (dirty()) void save();
      }
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
    inFlight = drain().finally(() => { inFlight = undefined; if (syncPending()) void sync(); });

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

  const canChooseLocal = () => visible() && !loading() && !saving() && leaseValid() && ownership().owned;

  const useLocal = async () => {
    if (!canChooseLocal() || !local() || !document() || document()?.deleted || document()?.disabled) return;
    const next = recovery.create(content(), required(document()).version);
    setLocal(next); setUnconfirmed(undefined);
    await persist(next);
    await save();
  };

  onCleanup(registerPluginFlush(target.hostId, async enabled => {
    if (!transport.active()) return;
    setFlushing(true);

    try {
      if (pendingWork() && !await save() && !(document()?.disabled && enabled?.includes("markdown"))) throw new Error("The note has unsaved edits. Resolve its recovery copy before disconnecting or restarting plugins.");
      await storageOperations;

      if (recoveryError()) throw new Error(recoveryError());
    } finally { setFlushing(false); }
  }));

  const syncUnavailable = () => disposed || loading() || releasing() || !!inFlight || document()?.deleted;
  const releaseIfHidden = () => { if (!visible()) void release(); };

  const sync = async () => {
    if (disposed) return;
    if (checking || syncUnavailable()) { setSyncPending(true); return; }
    setSyncPending(false); checking = true;
    const current = generation;
    const note = document();

    try {
      const next = await readCurrent();

      if (current !== generation || syncUnavailable() || document() !== note) { setSyncPending(true); return; }
      setReadError(""); receiveUpdate(next); releaseIfHidden();
    } catch (reason) {
      if (!disposed && current === generation) setReadError(reason instanceof Error ? reason.message : String(reason));
    } finally { checking = false; if (syncPending() && !syncUnavailable()) void sync(); }
  };

  const relinquishHidden = (current: number) => {
    if (!disposed && current === generation && !visible() && durable()) relinquish();
  };

  const releaseFailed = (leaseToken: string, reason: unknown) => {
    const message = `Could not give up editing control of this note. Other clients can edit it after the lock expires. ${reason instanceof Error ? reason.message : String(reason)}`;
    console.error(message);

    if (disposed) return;
    pendingRelease = leaseToken; setReleaseError(message);
  };

  const retryRelease = async () => {
    const leaseToken = pendingRelease;

    if (!leaseToken || disposed || visible()) return;

    try {
      await call("release", { leaseToken });

      if (pendingRelease === leaseToken) { pendingRelease = undefined; setReleaseError(""); }
    } catch (reason) { if (pendingRelease === leaseToken) releaseFailed(leaseToken, reason); }
  };

  const forgetPendingRelease = () => { pendingRelease = undefined; setReleaseError(""); };

  const releaseOwned = async () => {
    await save();
    await storageOperations;

    if (!durable() || !disposed && visible()) return;
    const leaseToken = ownership().token;
    const current = generation;

    if (!leaseToken) { relinquish();

    return; }

    setLeaseValid(false);

    try {
      const next = await call("release", { leaseToken });

      if (!disposed && current === generation) { relinquish(); receiveUpdate(next); }
    } catch (reason) { releaseFailed(leaseToken, reason); relinquishHidden(current); }
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
    if (!stopUpdates || !stopRemovals) await subscribe();

    await retryRelease();

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

    if (current === visibilityRevision && visible() && !disposed && !document()?.deleted) { forgetPendingRelease(); await load("claim"); }
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

  createDependencyEffect(() => {
    if (syncPending() && !syncUnavailable()) void sync();
  }, () => [syncPending(), loading(), releasing(), saving(), document()]);

  let stopUpdates: UnlistenFn | undefined;
  let stopRemovals: UnlistenFn | undefined;
  let subscribing: Promise<void> | undefined;

  const installListeners = async () => {
    try {
      if (!stopUpdates) {
        const stop = await listen("pi://event", ({ payload }) => {
          if (!transport.active() || disposed) return;
          if (payload.type === "connection_restored") void retryRelease();
          if (payload.type === "connection_restored" || payload.type === "note_changed" && payload.hostId === target.hostId && payload.sessionId === target.sessionId) void sync();
        }, z.object({ type: z.string().optional(), hostId: z.string().optional(), sessionId: z.string().optional() }));
        if (disposed) { stop(); return; }
        stopUpdates = stop;
      }

      if (!stopRemovals) {
        const stop = await listen("pi://session-removed", ({ payload }) => {
          if (transport.active() && !disposed && payload.hostId === target.hostId && payload.sessionId === target.sessionId) void sync();
        }, z.object({ hostId: z.string(), sessionId: z.string().nullable() }));
        if (disposed) { stop(); return; }
        stopRemovals = stop;
      }

      setSubscriptionError("");
    } catch (reason) { setSubscriptionError("Could not listen for note changes. " + String(reason)); }
  };

  const subscribe = () => {
    subscribing ??= installListeners().finally(() => { subscribing = undefined; });

    return subscribing;
  };

  onMount(() => {
    void (async () => {
      await subscribe();
      if (!disposed) await load(visible() ? "claim" : "read");
    })();
  });
  window.addEventListener("focus", resume);
  window.document.addEventListener("visibilitychange", resume);
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { disposed = true; clearTimeout(leaseTimer); stopUpdates?.(); stopRemovals?.(); window.removeEventListener("focus", resume); window.document.removeEventListener("visibilitychange", resume); window.removeEventListener("beforeunload", beforeUnload); void release(); });

  const ready = () => !!document() && !document()?.deleted && !document()?.disabled;
  const pending = () => loading() || saving() || releasing() || dirty() || !durable() || storagePending() > 0 || !!recoveryError() || ownership().owned;

  const recoveryCopies = () => {
    const source = recoveredSource();
    const unique: NoteRecovery[] = [];

    for (const value of recoveries()) {
      if (source && matchingCopy(value, source)) continue;

      if (!unique.some(copy => matchingCopy(copy, value))) unique.push(value);
    }

    return unique;
  };

  return { content, loading, saving, error, dirty, conflict, durable, owned: () => ownership().owned, savedVersion: () => document()?.version, saveEdits: useLocal, recoveries: recoveryCopies, restore, discardRecovery, useSaved, useLocal, savedContent: () => document()?.content ?? "", deleted: () => document()?.deleted, disabled: () => document()?.disabled, ready, pending, editable, edit, save, retry, takeControl };
}
