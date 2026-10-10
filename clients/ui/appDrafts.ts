import { DraftHostStorage } from "./lib/draftHostStorage";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { NativeTransport, type NativeConnectionTarget } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { ComposerUpload, SessionSummary } from "./types";
import { draftEndpoint, durableDraftId, type DraftDestination, type DraftStorageIssue, type DurableDraft, type DurableSubmission } from "./lib/draftStorage";
import { bindDraftStaging, goalPreparationSchema, submissionFingerprint, type DraftSubmissionHandle, type DraftSubmissionPayload } from "./lib/draftSubmission";
import type { DraftConflictSnapshot } from "./lib/draftStorage";

export interface ConversationDraft { text: string; uploads: ComposerUpload[]; target?: NativeConnectionTarget; updatedAt: number; }

const mergeText = (previous: string, newer: string) => !previous ? newer : newer && newer !== previous ? `${previous}\n\n${newer}` : previous;

const mergeUploads = (previous: ComposerUpload[], newer: ComposerUpload[]) => [...previous.filter(item => !newer.some(other => other.id === item.id)), ...newer];

function restoredDraft(record: DurableDraft, current: DurableDraft, textChanged: boolean, uploadsChanged: boolean): DurableDraft {
  const text = textChanged ? current.text : record.text;
  const uploads = uploadsChanged ? current.uploads : record.uploads;
  const destination = current.destination ? { ...current.destination, cwd: current.destination.cwd ?? record.destination?.cwd, sessionPath: current.destination.sessionPath ?? record.destination?.sessionPath } : record.destination;

  return { ...record, text, uploads, destination };
}

export function createConversationDrafts() {
  const endpoint = draftEndpoint();
  const storage = new DraftHostStorage();
  const [records, setRecords] = createSignal<Map<string, DurableDraft>>(new Map());
  const [submissions, setSubmissions] = createSignal<DurableSubmission[]>([]);
  const [uploadsByTransport, setUploadsByTransport] = createSignal<Map<NativeTransport, ComposerUpload[]>>(new Map());
  const [persistenceError, setPersistenceError] = createSignal<string>();
  const [storageIssues, setStorageIssues] = createSignal<DraftStorageIssue[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [pendingWrites, setPendingWrites] = createSignal(0);
  const [conflictCount, setConflictCount] = createSignal(0);
  const owners = new Map<NativeTransport, string>();
  const aliases = new Map<string, string>();
  const redirected = new WeakMap<NativeTransport, NativeTransport>();
  const textChanged = new Set<string>();
  const uploadsChanged = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let revisionEpoch = 0;
  let loading: Promise<void> | undefined;

  const report = (reason: Error | string) => { setConflictCount(storage.conflictCount()); setPersistenceError(`Could not save draft content: ${reason instanceof Error ? reason.message : reason}. Keep this window open and retry saving before reloading.`); };

  const keyFor = (key: string): string => aliases.has(key) ? keyFor(aliases.get(key) ?? key) : key;
  const ownerFor = (owner: NativeTransport): NativeTransport => redirected.has(owner) ? ownerFor(redirected.get(owner) ?? owner) : owner;
  const empty = (key: string): DurableDraft => ({ id: durableDraftId(endpoint, key), endpoint, key, text: "", uploads: [], updatedAt: Date.now() });
  const recordFor = (key: string) => records().get(keyFor(key)) ?? empty(keyFor(key));

  const publishUploads = () => setUploadsByTransport(new Map([...owners].map(([owner, key]) => [owner, recordFor(key).uploads])));
  const publish = (record: DurableDraft) => { setRecords(current => new Map(current).set(record.key, record)); publishUploads(); };

  const enqueue = (operation: () => Promise<void>) => {
    setPendingWrites(current => current + 1);
    const epoch = revisionEpoch;

    const result = queue.then(() => ready).then(() => {
      if (epoch !== revisionEpoch) throw new Error("Saved input was reloaded before this change could be saved. Retry saving the remaining input.");

      return operation();
    }).finally(() => setPendingWrites(current => current - 1));

    queue = result.catch(reason => { report(reason); });

    return result;
  };

  const save = (record: DurableDraft) => enqueue(async () => { const current = recordFor(record.key); await storage.commit([current]); });

  const update = (key: string, transform: (record: DurableDraft) => DurableDraft) => {
    const next = transform(recordFor(key)); publish(next);
    void save(next).catch(() => undefined);

    return next;
  };

  const restoreDrafts = (saved: DurableDraft[]) => {
    for (const record of saved) publish(restoredDraft(record, recordFor(record.key), textChanged.has(record.key), uploadsChanged.has(record.key)));
  };

  const load = () => loading ??= storage.load(endpoint).then(async restored => {
    setStorageIssues(restored.issues);
    setConflictCount(storage.conflictCount());
    restoreDrafts(restored.drafts);
    setSubmissions(restored.submissions);

    for (const submission of restored.submissions) {
      const record = recordFor(submission.destination.key);

      if (!record.text && !record.uploads.length) publish({ ...record, destination: submission.destination, updatedAt: submission.createdAt });
    }


    setLoaded(true);
  }).catch(reason => { report(reason); throw reason; }).finally(() => { loading = undefined; });

  let ready = load();
  void ready.catch(() => undefined);

  const composerDrafts = createMemo(() => Object.fromEntries([...records()].map(([key, record]) => [key, record.text])));

  const setComposerDraft = (sessionKey: string, value: StateUpdate<string>) => {
    const key = keyFor(sessionKey);
    textChanged.add(key);
    const text = value instanceof Function ? value(recordFor(key).text) : value;
    update(key, record => ({ ...record, text, updatedAt: Date.now() }));
  };

  const setComposerUploads = (transport: NativeTransport | string, value: StateUpdate<ComposerUpload[]>) => {
    const key = transport instanceof NativeTransport ? keyForTransport(transport) : keyFor(transport);

    uploadsChanged.add(key);
    update(key, record => ({ ...record, uploads: value instanceof Function ? value(record.uploads) : value, updatedAt: Date.now() }));
  };

  const destinationFor = (owner: NativeTransport): DraftDestination => {
    const key = owners.get(owner);

    if (!key) throw new Error("The draft destination is unavailable");

    const previous = recordFor(key).destination;

    const sessionPath = owner.currentSessionPath() ?? previous?.sessionPath;
    const temporary = owner.isTemporaryChat();

    return { key: keyFor(key), endpoint, hostId: owner.currentHostId(), cwd: !sessionPath && temporary ? undefined : owner.currentCwd() ?? previous?.cwd, sessionPath, temporary };
  };

  const storeSubmission = async (submission: DurableSubmission) => {
    await enqueue(() => storage.commit([], [submission]));
    setSubmissions(current => [...current.filter(item => item.id !== submission.id), submission]);
  };

  const retireSubmission = async (id: string) => {
    await enqueue(() => storage.commit([], [], [], [id]));
    setSubmissions(current => current.filter(item => item.id !== id));
  };

  const restoreSubmission = async (submission: DurableSubmission) => {
    const key = keyFor(submission.destination.key);
    const fingerprint = await submissionFingerprint(submission.rawText, submission.uploads);
    const record = { ...recordFor(key), destination: { ...submission.destination, key }, text: mergeText(submission.rawText, recordFor(key).text), uploads: mergeUploads(submission.uploads, recordFor(key).uploads), updatedAt: Date.now(), retrySubmission: { id: submission.id, fingerprint } };
    publish(record);
    await enqueue(() => storage.commit([record], [], [], [submission.id]));
    setSubmissions(current => current.filter(item => item.id !== submission.id));

  };

  const transferSubmission = async (submission: DurableSubmission, source: NativeTransport, destination: NativeTransport, committed: (next: DurableSubmission) => void) => {
    const previousKey = keyFor(submission.destination.key);
    const target = destinationFor(destination);
    const next = { ...submission, destination: target };
    let transferred = recordFor(target.key);
    let previous = recordFor(previousKey);
    await enqueue(async () => {
      previous = recordFor(previousKey);
      transferred = { ...recordFor(target.key), destination: target, text: mergeText(previous.text, recordFor(target.key).text), uploads: mergeUploads(previous.uploads, recordFor(target.key).uploads), updatedAt: Date.now() };
      await storage.commit([transferred, { ...previous, text: "", uploads: [] }], [next]);
    });
    committed(next);
    const latest = recordFor(previousKey);
    const additions = latest.uploads.filter(upload => !previous.uploads.some(item => item.id === upload.id));
    const text = latest.text === previous.text ? transferred.text : mergeText(transferred.text, latest.text);
    redirected.set(source, destination);
    publish({ ...latest, text: "", uploads: [] });
    publish({ ...transferred, text, uploads: mergeUploads(transferred.uploads, additions) });
    setSubmissions(current => current.map(item => item.id === next.id ? next : item));

    await enqueue(() => storage.commit([recordFor(target.key), recordFor(previousKey)], [next]));

    return next;
  };

  const stage = async (initialOwner: NativeTransport, payload: DraftSubmissionPayload): Promise<DraftSubmissionHandle> => {
    await ready;
    let owner = ownerFor(initialOwner);
    const destination = destinationFor(owner);
    const fingerprint = await submissionFingerprint(payload.rawText, payload.uploads);
    const retry = recordFor(destination.key).retrySubmission;
    const id = retry?.fingerprint === fingerprint ? retry.id : crypto.randomUUID();
    let submission: DurableSubmission = { id, destination, rawText: payload.rawText, uploads: payload.uploads, status: "preparing", createdAt: Date.now() };
    await storeSubmission(submission);
    update(destination.key, current => ({ ...current, retrySubmission: undefined }));

    if (payload.consume) {
      setComposerDraft(submission.destination.key, current => current === payload.rawText ? "" : current);
      const ids = new Set(payload.uploads.map(upload => upload.id));
      setComposerUploads(owner, current => current.filter(upload => !ids.has(upload.id)));
    }

    let dispatched = false;

    return {
      id: submission.id, owner: () => owner, wasDispatched: () => dispatched,
      move: async destination => { await transferSubmission(submission, owner, destination, next => { submission = next; owner = destination; }); },
      dispatch: async () => { const next: DurableSubmission = { ...submission, destination: destinationFor(owner), status: "uncertain" }; await storeSubmission(next); submission = next; dispatched = true; },
      accept: () => retireSubmission(submission.id),
      reject: async reason => { submission = { ...submission, destination: destinationFor(owner), error: reason }; await restoreSubmission(submission); },
      uncertain: async reason => { submission = { ...submission, destination: destinationFor(owner), status: "uncertain", error: reason }; await storeSubmission(submission); },
    };
  };

  const bindTransport = (owner: NativeTransport, key: string) => {
    const target = owner.connectionTarget();

    if (target.draftKey === key || target.sessionId && key === `${owner.currentHostId()}:${target.sessionId}`) aliases.delete(key);
    const resolved = keyFor(key);
    owners.set(owner, resolved);
    const destination = destinationFor(owner); const previous = recordFor(resolved);

    if (JSON.stringify(previous.destination) !== JSON.stringify(destination)) update(resolved, record => ({ ...record, destination }));
    publishUploads();
    bindDraftStaging(owner, payload => stage(owner, payload));
  };

  const keyForTransport = (transport: NativeTransport) => {
    const owner = ownerFor(transport);
    const existing = owners.get(owner);

    if (existing) return keyFor(existing);
    const target = owner.connectionTarget();
    const key = target.draftKey ?? `${owner.currentHostId()}:${target.sessionId ?? `draft-${crypto.randomUUID()}`}`;
    bindTransport(owner, key);

    return keyFor(key);
  };

  const transportHasDraft = (transport: NativeTransport, key?: string) => {
    const owner = ownerFor(transport); const resolved = key ? keyFor(key) : owners.get(owner);

    return Boolean(resolved && transportHasDraftForKey(resolved));
  };

  const rekeyDraft = (previousKey: string, nextKey: string, copy = false) => {
    if (previousKey === nextKey) return;
    const previous = recordFor(previousKey); const destination = previous.destination ? { ...previous.destination, key: nextKey } : undefined;
    const next = { ...previous, id: durableDraftId(endpoint, nextKey), key: nextKey, destination, uploads: mergeUploads(previous.uploads, recordFor(nextKey).uploads), text: mergeText(previous.text, recordFor(nextKey).text) };
    publish(next);

    if (!copy) {
      aliases.set(previousKey, nextKey);
      setRecords(current => { const next = new Map(current); next.delete(previousKey);

      return next; });
    }

    const moved = copy ? [] : submissions().flatMap(item => item.destination.key === previousKey ? [{ ...item, destination: { ...item.destination, key: nextKey } }] : []);
    setSubmissions(current => current.map(item => moved.find(next => next.id === item.id) ?? item));
    void enqueue(async () => { await storage.commit([next], moved, copy ? [] : [previous.id]); }).catch(() => undefined);
    publishUploads();
  };

  const discard = (owner: NativeTransport, key = owners.get(owner)) => {
    if (!key) return;
    const resolved = keyFor(key); const discarded = submissions().filter(item => keyFor(item.destination.key) === resolved);
    setComposerDraft(resolved, ""); update(resolved, record => ({ ...record, uploads: [] }));
    void enqueue(async () => { await storage.commit([], [], [], discarded.map(item => item.id)); setSubmissions(current => current.filter(item => !discarded.includes(item))); }).catch(() => undefined);
  };

  const transportHasDraftForKey = (key: string) => { const record = recordFor(key);

    return Boolean(record.text || record.uploads.length || submissions().some(item => keyFor(item.destination.key) === key)); };

  const draftSummaries = createMemo<SessionSummary[]>(() => [...records().values()].flatMap(record => {
    const destination = record.destination;

    if (!destination || !transportHasDraftForKey(record.key)) return [];
    const pending = submissions().find(item => keyFor(item.destination.key) === record.key);
    const preview = record.text || pending?.rawText || "Attachments";

    return [{ id: record.key.slice(destination.hostId.length + 1), hostId: destination.hostId, hostName: endpoint, isDraft: !destination.sessionPath, cwd: destination.cwd ?? "", path: destination.sessionPath ?? "", project: destination.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Temporary chat", name: preview.slice(0, 60), preview, messageCount: 0, lastMessageAt: record.updatedAt, apiCost: 0 }];
  }));

  const legacyRecoveries = createMemo(() => [...records().values()].filter(record => !record.destination && Boolean(record.text || record.uploads.length)));

  const retryPersistence = async () => {
    if (!loaded()) { ready = load(); await ready; }

    await enqueue(() => storage.commit([...records().values()], submissions())); setPersistenceError(undefined);
  };

  const applyConflicts = (snapshot: DraftConflictSnapshot) => {
    const changedDrafts = new Set(snapshot.changes.flatMap(change => change.store === "drafts" ? [change.id] : []));
    const changedSubmissions = new Set(snapshot.changes.flatMap(change => change.store === "submissions" ? [change.id] : []));
    storage.acceptConflicts(snapshot); revisionEpoch += 1;

    for (const key of aliases.keys()) if (changedDrafts.has(durableDraftId(endpoint, key))) aliases.delete(key);
    setRecords(current => new Map([...current].filter(([, record]) => !changedDrafts.has(record.id))));

    for (const record of snapshot.drafts) publish(record);
    setSubmissions(current => [...current.filter(item => !changedSubmissions.has(item.id)), ...snapshot.submissions]);

    publishUploads(); setConflictCount(storage.conflictCount()); setPersistenceError(undefined);
  };

  const reloadConflicts = () => enqueue(async () => {
    const previousRecords = records(); const previousSubmissions = submissions();
    const snapshot = await storage.readConflicts();

    if (records() !== previousRecords || submissions() !== previousSubmissions) throw new Error("Input changed while saved content was loading. Copy any input you want to keep and try reloading changed items again.");
    applyConflicts(snapshot);
  });

  const copyLegacyDraft = (owner: NativeTransport, draft: DurableDraft) => {
    const key = keyForTransport(owner);
    setComposerDraft(key, current => mergeText(draft.text, current));
    setComposerUploads(owner, current => mergeUploads(draft.uploads, current));
  };

  const flush = async () => {
    if (!loaded() || persistenceError()) await retryPersistence();

    for (;;) {
      const current = queue;
      await current;

      if (current === queue) break;
    }

    if (persistenceError()) throw new Error(persistenceError());
  };

  const retry = () => { if (!loaded() || persistenceError()) void retryPersistence().catch(() => undefined); };

  window.addEventListener("focus", retry); window.addEventListener("online", retry);
  onCleanup(() => { window.removeEventListener("focus", retry); window.removeEventListener("online", retry); });

  const removeMatchingDrafts = (matches: (key: string, destination?: DraftDestination) => boolean) => {
    void enqueue(async () => {
      const removed = [...records().values()].filter(record => matches(record.key, record.destination));
      const removedSubmissions = submissions().filter(item => matches(item.destination.key, item.destination));
      await storage.commit([], [], removed.map(record => record.id), removedSubmissions.map(item => item.id));
      setRecords(current => new Map([...current].filter(([key]) => !removed.some(record => record.key === key))));
      setSubmissions(current => current.filter(item => !removedSubmissions.includes(item)));


      publishUploads();
    }).catch(() => undefined);
  };

  const removeDraft = (key: string) => removeMatchingDrafts(candidate => candidate === key);

  const removeSessionDrafts = (hostId: string, sessionPath?: string, sessionId?: string) => removeMatchingDrafts((key, destination) =>
    (destination?.hostId ?? key.slice(0, key.lastIndexOf(":"))) === hostId && Boolean(sessionId && key === `${hostId}:${sessionId}` || sessionPath && destination?.sessionPath === sessionPath));

  const setDraftTarget = (key: string, target: NativeConnectionTarget) => update(key, record => ({ ...record, destination: { key, endpoint, hostId: target.hostId ?? "local", cwd: target.cwd, sessionPath: target.sessionPath, temporary: !target.cwd && !target.sessionPath } }));
  const draftRecords = createMemo<Record<string, ConversationDraft>>(() => Object.fromEntries([...records()].map(([key, record]) => [key, { text: record.text, uploads: record.uploads, updatedAt: record.updatedAt, target: record.destination ? { hostId: record.destination.hostId, cwd: record.destination.cwd, sessionPath: record.destination.sessionPath, sessionId: record.destination.sessionPath ? key.slice(record.destination.hostId.length + 1) : undefined, draftKey: record.destination.sessionPath ? undefined : key } : undefined }])));

  const setTransportDraft = (transport: NativeTransport, value: StateUpdate<string>) => {
    const owner = ownerFor(transport); const key = owners.get(owner);

    if (key) setComposerDraft(key, value);
    else report("The text destination is unavailable");
  };

  const inspectGoalPreparation = (submission: DurableSubmission) => {
    const key = keyFor(submission.destination.key);
    const owner = [...owners.keys()].reverse().find(owner => owners.get(ownerFor(owner)) === key);

    if (!owner) throw new Error("Open this conversation and wait for it to connect before inspecting the prepared goal.");

    return ownerFor(owner).command({ type: "get_goal_preparation", goalSubmissionId: submission.id }, goalPreparationSchema.nullable());
  };

  return { endpoint, ready, loaded, isReady: loaded, isSaving: () => pendingWrites() > 0, saveError: persistenceError, flush, records: draftRecords, hasDraft: transportHasDraftForKey, uploadsFor: (key: string) => recordFor(key).uploads, setDraftTarget, keyForTransport, removeSessionDrafts, composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, setTransportDraft, transportHasDraft, inspectGoalPreparation, rekeyDraft, removeDraft, discard, bindTransport, draftSummaries, legacyRecoveries, submissions, persistenceError, storageIssues, retryPersistence, restoreSubmission, retireSubmission, conflictCount, reloadConflicts, copyLegacyDraft };
}
