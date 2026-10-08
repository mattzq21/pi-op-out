import { createMemo, createSignal } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { ComposerUpload, SessionSummary } from "./types";
import { z } from "zod";
import { DraftStorage, draftEndpoint, durableDraftId, type DraftDestination, type DraftStorageIssue, type DurableDraft, type DurableSubmission } from "./lib/draftStorage";
import { bindDraftStaging, goalPreparationSchema, submissionFingerprint, type DraftSubmissionHandle, type DraftSubmissionPayload } from "./lib/draftSubmission";

const stringsSchema = z.record(z.string(), z.string());

const mergeText = (previous: string, newer: string) => !previous ? newer : newer && newer !== previous ? `${previous}\n\n${newer}` : previous;

const mergeUploads = (previous: ComposerUpload[], newer: ComposerUpload[]) => [...previous.filter(item => !newer.some(other => other.id === item.id)), ...newer];

function legacyDrafts(key: string) {
  try { return stringsSchema.parse(JSON.parse(localStorage.getItem(key) ?? "{}")); }
  catch { return {}; }
}

function restoredDraft(record: DurableDraft, current: DurableDraft, legacyText: string | undefined, textChanged: boolean, uploadsChanged: boolean): DurableDraft {
  const text = textChanged ? current.text : legacyText ?? record.text;
  const uploads = uploadsChanged ? current.uploads : record.uploads;
  const destination = current.destination ? { ...current.destination, cwd: current.destination.cwd ?? record.destination?.cwd, sessionPath: current.destination.sessionPath ?? record.destination?.sessionPath } : record.destination;

  return { ...record, text, uploads, destination };
}

export function createConversationDrafts() {
  const endpoint = draftEndpoint();
  const legacyKey = `piop-conversation-drafts:v1:${endpoint}`;
  const storage = new DraftStorage();
  const legacy = legacyDrafts(legacyKey);
  const [records, setRecords] = createSignal<Map<string, DurableDraft>>(new Map(Object.entries(legacy).map(([key, text]) => [key, { id: durableDraftId(endpoint, key), endpoint, key, text, uploads: [], updatedAt: Date.now() }])));
  const [submissions, setSubmissions] = createSignal<DurableSubmission[]>([]);
  const [uploadsByTransport, setUploadsByTransport] = createSignal<Map<NativeTransport, ComposerUpload[]>>(new Map());
  const [persistenceError, setPersistenceError] = createSignal<string>();
  const [storageIssues, setStorageIssues] = createSignal<DraftStorageIssue[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const owners = new Map<NativeTransport, string>();
  const aliases = new Map<string, string>();
  const redirected = new WeakMap<NativeTransport, NativeTransport>();
  const textChanged = new Set<string>();
  const uploadsChanged = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  const report = (reason: Error | string) => setPersistenceError(`Could not save draft content: ${reason instanceof Error ? reason.message : reason}. Keep this window open and retry saving before reloading.`);
  const keyFor = (key: string): string => aliases.has(key) ? keyFor(aliases.get(key) ?? key) : key;
  const ownerFor = (owner: NativeTransport): NativeTransport => redirected.has(owner) ? ownerFor(redirected.get(owner) ?? owner) : owner;
  const empty = (key: string): DurableDraft => ({ id: durableDraftId(endpoint, key), endpoint, key, text: "", uploads: [], updatedAt: Date.now() });
  const recordFor = (key: string) => records().get(keyFor(key)) ?? empty(keyFor(key));

  const publishUploads = () => setUploadsByTransport(new Map([...owners].map(([owner, key]) => [owner, recordFor(key).uploads])));
  const publish = (record: DurableDraft) => { setRecords(current => new Map(current).set(record.key, record)); publishUploads(); };

  const enqueue = (operation: () => Promise<void>) => {
    const result = queue.then(() => ready).then(operation);
    queue = result.catch(reason => { report(reason); });

    return result;
  };

  const preserveText = (key: string, text: string) => {
    try { const stored = legacyDrafts(legacyKey); stored[key] = text; localStorage.setItem(legacyKey, JSON.stringify(stored)); }
    catch (reason) { report(String(reason)); }
  };

  const retireLegacy = (record: DurableDraft) => {
    const stored = legacyDrafts(legacyKey);

    if (stored[record.key] !== record.text) return;
    delete stored[record.key];

    try { localStorage.setItem(legacyKey, JSON.stringify(stored)); } catch (reason) { report(String(reason)); }
  };

  const save = (record: DurableDraft) => enqueue(async () => { const current = recordFor(record.key); await storage.commit([current]); retireLegacy(current); });

  const update = (key: string, transform: (record: DurableDraft) => DurableDraft) => {
    const next = transform(recordFor(key)); publish(next);
    void save(next).catch(() => undefined);

    return next;
  };

  const load = () => storage.load(endpoint).then(async restored => {
    setStorageIssues(restored.issues);

    for (const record of restored.drafts) {
      const current = recordFor(record.key);
      publish(restoredDraft(record, current, legacy[record.key], textChanged.has(record.key), uploadsChanged.has(record.key)));
    }

    setSubmissions(restored.submissions);

    for (const submission of restored.submissions) {
      const record = recordFor(submission.destination.key);

      if (!record.text && !record.uploads.length) publish({ ...record, destination: submission.destination, updatedAt: submission.createdAt });
    }

    const migrated = [...records().values()].filter(record => record.key in legacy && !restored.issues.some(issue => issue.kind === "draft" && issue.id === record.id));
    await storage.commit(migrated);

    for (const record of migrated) retireLegacy(record);
    setLoaded(true);
  }).catch(reason => { report(reason); throw reason; });

  let ready = load();
  void ready.catch(() => undefined);

  const composerDrafts = createMemo(() => Object.fromEntries([...records()].map(([key, record]) => [key, record.text])));

  const setComposerDraft = (sessionKey: string, value: StateUpdate<string>) => {
    const key = keyFor(sessionKey);
    textChanged.add(key);
    const text = value instanceof Function ? value(recordFor(key).text) : value;
    preserveText(key, text);
    update(key, record => ({ ...record, text, updatedAt: Date.now() }));
  };

  const setComposerUploads = (transport: NativeTransport, value: StateUpdate<ComposerUpload[]>) => {
    const owner = ownerFor(transport); const key = owners.get(owner);

    if (!key) { report("The attachment destination is unavailable");

    return; }

    uploadsChanged.add(key);
    update(key, record => ({ ...record, uploads: value instanceof Function ? value(record.uploads) : value, updatedAt: Date.now() }));
  };

  const destinationFor = (owner: NativeTransport): DraftDestination => {
    const key = owners.get(owner);

    if (!key) throw new Error("The draft destination is unavailable");

    const previous = recordFor(key).destination;

    return { key: keyFor(key), endpoint, hostId: owner.currentHostId(), cwd: owner.currentCwd() ?? previous?.cwd, sessionPath: owner.currentSessionPath() ?? previous?.sessionPath, temporary: owner.isTemporaryChat() };
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
    preserveText(key, record.text); publish(record);
    await enqueue(() => storage.commit([record], [], [], [submission.id]));
    setSubmissions(current => current.filter(item => item.id !== submission.id));
    retireLegacy(record);
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
    retireLegacy(previous);
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
    const resolved = keyFor(key);
    owners.set(owner, resolved);
    const destination = destinationFor(owner); const previous = recordFor(resolved);

    if (JSON.stringify(previous.destination) !== JSON.stringify(destination)) update(resolved, record => ({ ...record, destination }));
    publishUploads();
    bindDraftStaging(owner, payload => stage(owner, payload));
  };

  const transportHasDraft = (transport: NativeTransport, key?: string) => {
    const owner = ownerFor(transport); const resolved = key ? keyFor(key) : owners.get(owner);

    return Boolean(resolved && transportHasDraftForKey(resolved));
  };

  const rekeyDraft = (previousKey: string, nextKey: string, copy = false) => {
    const previous = recordFor(previousKey); const destination = previous.destination ? { ...previous.destination, key: nextKey } : undefined;
    const next = { ...previous, id: durableDraftId(endpoint, nextKey), key: nextKey, destination, uploads: mergeUploads(previous.uploads, recordFor(nextKey).uploads), text: mergeText(previous.text, recordFor(nextKey).text) };
    publish(next);

    if (!copy) {
      aliases.set(previousKey, nextKey);
      setRecords(current => { const next = new Map(current); next.delete(previousKey);

      return next; });
    }

    const moved = submissions().flatMap(item => item.destination.key === previousKey ? [{ ...item, destination: { ...item.destination, key: nextKey } }] : []);
    setSubmissions(current => current.map(item => moved.find(next => next.id === item.id) ?? item));
    void enqueue(async () => { await storage.commit([next], moved, copy ? [] : [previous.id]); retireLegacy(previous); }).catch(() => undefined);
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

    return [{ id: record.key.slice(destination.hostId.length + 1), hostId: destination.hostId, hostName: endpoint, isDraft: record.key.startsWith(`${destination.hostId}:draft-`), cwd: destination.cwd ?? "", path: destination.sessionPath ?? "", project: destination.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Temporary chat", name: preview.slice(0, 60), preview, messageCount: 0, lastMessageAt: record.updatedAt, apiCost: 0 }];
  }));

  const legacyRecoveries = createMemo(() => [...records().values()].filter(record => !record.destination && Boolean(record.text || record.uploads.length)));

  const retryPersistence = async () => {
    if (!loaded()) { ready = load(); await ready; }

    await enqueue(() => storage.commit([...records().values()], submissions())); setPersistenceError(undefined);
  };

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

  return { endpoint, ready, loaded, composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, setTransportDraft, transportHasDraft, inspectGoalPreparation, rekeyDraft, removeDraft: (key: string) => setComposerDraft(key, ""), discard, bindTransport, draftSummaries, legacyRecoveries, submissions, persistenceError, storageIssues, retryPersistence, restoreSubmission, retireSubmission };
}
