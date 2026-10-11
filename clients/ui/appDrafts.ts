import { batch, createComputed, createMemo, createSignal, onCleanup } from "solid-js";
import { NativeTransport, type NativeConnectionTarget } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { AppSettings, ComposerUpload, SessionSummary } from "./types";
import type { DraftDestination, DraftRecord, DraftSubmission } from "./lib/draftState";
import { bindDraftStaging, goalPreparationSchema, submissionFingerprint, type DraftSubmissionHandle, type DraftSubmissionPayload } from "./lib/draftSubmission";
import { createDraftPersistence } from "./lib/draftPersistence";

export interface ConversationDraft { text: string; uploads: ComposerUpload[]; target?: NativeConnectionTarget; updatedAt: number; }

const mergeText = (previous: string, newer: string) => !previous ? newer : newer && newer !== previous ? `${previous}\n\n${newer}` : previous;

const mergeUploads = (previous: ComposerUpload[], newer: ComposerUpload[]) => [...previous.filter(item => !newer.some(other => other.id === item.id)), ...newer];

export function createConversationDrafts(reportStorageError: (message: string) => void) {
  const reportDraftStorageError = (reason: unknown) => reportStorageError(reason instanceof Error ? reason.message : String(reason));
  let enabledHosts: Set<string> | undefined;
  const [records, setRecords] = createSignal<Map<string, DraftRecord>>(new Map());
  const [submissions, setSubmissions] = createSignal<DraftSubmission[]>([]);
  const [uploadsByTransport, setUploadsByTransport] = createSignal<Map<NativeTransport, ComposerUpload[]>>(new Map());
  const destinations = new Map<string, DraftDestination>();
  const owners = new Map<NativeTransport, string>();
  const aliases = new Map<string, string>();
  const redirected = new WeakMap<NativeTransport, NativeTransport>();
  const allows = (key: string, destination?: DraftDestination) => !enabledHosts || enabledHosts.has(destination?.hostId ?? key.slice(0, key.lastIndexOf(":")));

  const persistence = createDraftPersistence();
  const removedBeforeLoad: Array<(key: string, destination?: DraftDestination) => boolean> = [];
  let loaded = false;
  let disposed = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const ready = persistence.read().then(saved => {
    batch(() => {
      const next = new Map(saved.records.filter(record => allows(record.key, record.destination) && !removedBeforeLoad.some(matches => matches(record.key, record.destination))).map(record => [record.key, record]));
      for (const [key, record] of records()) {
        const previous = next.get(key);
        next.set(key, previous ? { ...previous, ...record, text: mergeText(previous.text, record.text), uploads: mergeUploads(previous.uploads, record.uploads) } : record);
      }
      setRecords(next);
      setSubmissions(saved.submissions.filter(item => allows(item.destination.key, item.destination) && !removedBeforeLoad.some(matches => matches(item.destination.key, item.destination))));
      for (const record of next.values()) if (record.destination) destinations.set(record.key, record.destination);
      publishUploads();
      loaded = true;
      removedBeforeLoad.length = 0;
    });
  });
  void ready.catch(reportDraftStorageError);
  let queue: Promise<unknown> = ready;
  const save = () => {
    queue = queue.catch(() => undefined).then(async () => {
      await ready;
      await persistence.write({ records: [...records().values()], submissions: submissions() });
    });
    void queue.catch(reportDraftStorageError);

    return queue;
  };
  const flush = () => { if (scheduled === undefined) return; clearTimeout(scheduled); scheduled = undefined; if (!disposed) void save(); };
  createComputed(() => {
    records(); submissions();

    if (scheduled !== undefined) return;
    scheduled = setTimeout(flush, 300);
  });
  const hidden = () => { if (document.visibilityState === "hidden") flush(); };
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", flush);
  onCleanup(() => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", flush); flush(); disposed = true; void queue.finally(() => persistence.close()).catch(reportDraftStorageError); });

  const keyFor = (key: string): string => {
    const visited = new Set<string>();

    while (aliases.has(key) && !visited.has(key)) {
      visited.add(key);
      key = aliases.get(key) ?? key;
    }

    return key;
  };
  const ownerFor = (owner: NativeTransport): NativeTransport => redirected.has(owner) ? ownerFor(redirected.get(owner) ?? owner) : owner;
  const empty = (key: string): DraftRecord => ({ key, destination: destinations.get(key), text: "", uploads: [], updatedAt: Date.now() });
  const recordFor = (key: string) => records().get(keyFor(key)) ?? empty(keyFor(key));

  const publishUploads = () => setUploadsByTransport(new Map([...owners].map(([owner, key]) => [owner, recordFor(key).uploads])));

  const publish = (record: DraftRecord) => {
    if (!allows(record.key, record.destination)) return;

    if (record.destination) destinations.set(record.key, record.destination);
    setRecords(current => {
      const next = new Map(current);

      if (record.text || record.uploads.length) next.set(record.key, record);
      else next.delete(record.key);

      return next;
    });
    publishUploads();
  };

  const update = (key: string, transform: (record: DraftRecord) => DraftRecord) => {
    const next = transform(recordFor(key));

    if (!allows(next.key, next.destination)) return recordFor(key);
    publish(next);

    return next;
  };

  const composerDrafts = createMemo(() => Object.fromEntries([...records()].map(([key, record]) => [key, record.text])));

  const setComposerDraft = (sessionKey: string, value: StateUpdate<string>) => {
    const key = keyFor(sessionKey);
    const text = value instanceof Function ? value(recordFor(key).text) : value;
    update(key, record => ({ ...record, text, updatedAt: Date.now() }));
  };

  const setComposerUploads = (transport: NativeTransport | string, value: StateUpdate<ComposerUpload[]>) => {
    const key = transport instanceof NativeTransport ? keyForTransport(transport) : keyFor(transport);

    update(key, record => ({ ...record, uploads: value instanceof Function ? value(record.uploads) : value, updatedAt: Date.now() }));
  };

  const destinationFor = (owner: NativeTransport): DraftDestination => {
    const key = owners.get(owner);

    if (!key) throw new Error("The draft destination is unavailable");

    const previous = recordFor(key).destination;

    const sessionPath = owner.currentSessionPath() ?? previous?.sessionPath;
    const temporary = owner.isTemporaryChat();

    return { key: keyFor(key), hostId: owner.currentHostId(), cwd: !sessionPath && temporary ? undefined : owner.currentCwd() ?? previous?.cwd, sessionPath, temporary };
  };

  const storeSubmission = async (submission: DraftSubmission) => {
    await ready;
    if (!allows(submission.destination.key, submission.destination)) throw new Error("This machine was removed or disabled");
    setSubmissions(current => [...current.filter(item => item.id !== submission.id), submission]);
    await save();
  };

  const retireSubmission = async (id: string) => {
    await ready;
    const previous = submissions().find(item => item.id === id);
    setSubmissions(current => current.filter(item => item.id !== id));
    try { await save(); }
    catch (reason) { if (previous) setSubmissions(current => [...current, previous]); throw reason; }
  };

  const restoreSubmission = async (submission: DraftSubmission) => {
    await ready;
    const key = keyFor(submission.destination.key);
    const fingerprint = await submissionFingerprint(submission.rawText, submission.uploads);
    const record = { ...recordFor(key), destination: { ...submission.destination, key }, text: mergeText(submission.rawText, recordFor(key).text), uploads: mergeUploads(submission.uploads, recordFor(key).uploads), updatedAt: Date.now(), retrySubmission: { id: submission.id, fingerprint } };
    batch(() => {
      publish(record);
      setSubmissions(current => current.filter(item => item.id !== submission.id));
    });
    await save();

  };

  const transferSubmission = async (submission: DraftSubmission, source: NativeTransport, destination: NativeTransport, committed: (next: DraftSubmission) => void) => {
    const previousKey = keyFor(submission.destination.key);
    const target = destinationFor(destination);
    const next = { ...submission, destination: target };
    const previous = recordFor(previousKey);
    const transferred = { ...recordFor(target.key), destination: target, text: mergeText(previous.text, recordFor(target.key).text), uploads: mergeUploads(previous.uploads, recordFor(target.key).uploads), updatedAt: Date.now() };
    committed(next);
    redirected.set(source, destination);
    publish({ ...previous, text: "", uploads: [] });
    publish(transferred);
    setSubmissions(current => current.map(item => item.id === next.id ? next : item));

    await save();

    return next;
  };

  const stage = async (initialOwner: NativeTransport, payload: DraftSubmissionPayload): Promise<DraftSubmissionHandle> => {
    await ready;
    let owner = ownerFor(initialOwner);
    const destination = destinationFor(owner);
    const fingerprint = await submissionFingerprint(payload.rawText, payload.uploads);
    const retry = recordFor(destination.key).retrySubmission;
    const id = retry?.fingerprint === fingerprint ? retry.id : crypto.randomUUID();
    let submission: DraftSubmission = { id, destination, rawText: payload.rawText, uploads: payload.uploads, status: "preparing", createdAt: Date.now() };
    await storeSubmission(submission);
    update(destination.key, current => ({ ...current, retrySubmission: undefined }));

    if (payload.consume) {
      setComposerDraft(submission.destination.key, current => current === payload.rawText ? "" : current);
      const ids = new Set(payload.uploads.map(upload => upload.id));
      setComposerUploads(owner, current => current.filter(upload => !ids.has(upload.id)));
    }

    await save();
    let dispatched = false;

    return {
      id: submission.id, owner: () => owner, wasDispatched: () => dispatched,
      move: async destination => { await transferSubmission(submission, owner, destination, next => { submission = next; owner = destination; }); },
      dispatch: async () => { const next: DraftSubmission = { ...submission, destination: destinationFor(owner), status: "uncertain" }; await storeSubmission(next); submission = next; dispatched = true; },
      accept: () => retireSubmission(submission.id),
      reject: async reason => { submission = { ...submission, destination: destinationFor(owner), error: reason }; await restoreSubmission(submission); },
      uncertain: async reason => { submission = { ...submission, destination: destinationFor(owner), status: "uncertain", error: reason }; await storeSubmission(submission); },
    };
  };

  const bindTransport = (owner: NativeTransport, key: string) => {
    const target = owner.connectionTarget();

    if (target.draftKey === key || target.sessionId && key === `${owner.currentHostId()}:${target.sessionId}`) aliases.delete(key);
    const resolved = keyFor(key); const bound = owners.has(owner);
    owners.set(owner, resolved);
    const destination = destinationFor(owner); const previous = recordFor(resolved);

    if (JSON.stringify(previous.destination) !== JSON.stringify(destination)) update(resolved, record => ({ ...record, destination }));
    publishUploads();
    bindDraftStaging(owner, payload => stage(owner, payload));

    if (!bound) owner.onDispose(() => { owners.delete(owner); publishUploads(); });
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
    const next = { ...previous, key: nextKey, destination, uploads: mergeUploads(previous.uploads, recordFor(nextKey).uploads), text: mergeText(previous.text, recordFor(nextKey).text) };
    aliases.delete(nextKey);
    publish(next);

    if (!copy) {
      destinations.delete(previousKey);
      for (const [key, target] of aliases) if (target === previousKey) aliases.set(key, nextKey);
      aliases.set(previousKey, nextKey);
      setRecords(current => { const next = new Map(current); next.delete(previousKey);

      return next; });
    }

    const moved = copy ? [] : submissions().flatMap(item => item.destination.key === previousKey ? [{ ...item, destination: { ...item.destination, key: nextKey } }] : []);
    setSubmissions(current => current.map(item => moved.find(next => next.id === item.id) ?? item));
    publishUploads();
  };

  const discard = (owner: NativeTransport, key = owners.get(owner)) => {
    if (!key) return;
    const resolved = keyFor(key); const discarded = submissions().filter(item => keyFor(item.destination.key) === resolved);
    setComposerDraft(resolved, ""); update(resolved, record => ({ ...record, uploads: [] }));
    setSubmissions(current => current.filter(item => !discarded.includes(item)));
  };

  const transportHasDraftForKey = (key: string) => { const record = recordFor(key);

    return Boolean(record.text || record.uploads.length || submissions().some(item => keyFor(item.destination.key) === key)); };

  const draftSummaries = createMemo<SessionSummary[]>(() => [...records().values()].flatMap(record => {
    const destination = record.destination;

    if (!destination || !transportHasDraftForKey(record.key)) return [];
    const pending = submissions().find(item => keyFor(item.destination.key) === record.key);
    const preview = record.text || pending?.rawText || "Attachments";

    return [{ id: record.key.slice(destination.hostId.length + 1), hostId: destination.hostId, isDraft: !destination.sessionPath, cwd: destination.cwd ?? "", path: destination.sessionPath ?? "", project: destination.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Temporary chat", name: preview.slice(0, 60), preview, messageCount: 0, lastMessageAt: record.updatedAt, apiCost: 0 }];
  }));

  const removeMatchingDrafts = (matches: (key: string, destination?: DraftDestination) => boolean) => {
    if (!loaded) removedBeforeLoad.push(matches);
    for (const [key, destination] of destinations) if (matches(key, destination)) destinations.delete(key);
    setRecords(current => new Map([...current].filter(([key, record]) => !matches(key, record.destination))));
    setSubmissions(current => current.filter(item => !matches(item.destination.key, item.destination)));
    publishUploads();
  };

  const configureHosts = (settings: AppSettings) => {
    const enabled = new Set(settings.hosts.filter(host => host.enabled !== false).map(host => host.id));

    if (settings.localEnabled !== false) enabled.add("local");
    enabledHosts = enabled;
    removeMatchingDrafts((key, destination) => !allows(key, destination));
  };

  const removeDraft = (key: string) => removeMatchingDrafts(candidate => candidate === key);

  const removeSessionDrafts = (hostId: string, sessionPath?: string, sessionId?: string) => removeMatchingDrafts((key, destination) =>
    (destination?.hostId ?? key.slice(0, key.lastIndexOf(":"))) === hostId && Boolean(sessionId && key === `${hostId}:${sessionId}` || sessionPath && destination?.sessionPath === sessionPath));

  const setDraftTarget = (key: string, target: NativeConnectionTarget) => update(key, record => ({ ...record, destination: { key, hostId: target.hostId ?? "local", cwd: target.cwd, sessionPath: target.sessionPath, temporary: !target.cwd && !target.sessionPath } }));
  const draftRecords = createMemo<Record<string, ConversationDraft>>(() => Object.fromEntries([...records()].map(([key, record]) => [key, { text: record.text, uploads: record.uploads, updatedAt: record.updatedAt, target: record.destination ? { hostId: record.destination.hostId, cwd: record.destination.cwd, sessionPath: record.destination.sessionPath, sessionId: record.destination.sessionPath ? key.slice(record.destination.hostId.length + 1) : undefined, draftKey: record.destination.sessionPath ? undefined : key } : undefined }])));

  const setTransportDraft = (transport: NativeTransport, value: StateUpdate<string>) => {
    const owner = ownerFor(transport); const key = owners.get(owner);

    if (key) setComposerDraft(key, value);
    else throw new Error("The text destination is unavailable");
  };

  const inspectGoalPreparation = (submission: DraftSubmission) => {
    const key = keyFor(submission.destination.key);
    const owner = [...owners.keys()].reverse().find(owner => owners.get(ownerFor(owner)) === key);

    if (!owner) throw new Error("Open this conversation and wait for it to connect before inspecting the prepared goal.");

    return ownerFor(owner).command({ type: "get_goal_preparation", goalSubmissionId: submission.id }, goalPreparationSchema.nullable());
  };

  return { configureHosts, records: draftRecords, hasDraft: transportHasDraftForKey, uploadsFor: (key: string) => recordFor(key).uploads, setDraftTarget, keyForTransport, removeSessionDrafts, composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, setTransportDraft, transportHasDraft, inspectGoalPreparation, rekeyDraft, removeDraft, discard, bindTransport, draftSummaries, submissions, restoreSubmission, retireSubmission };
}
