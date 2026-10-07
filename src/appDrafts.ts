import { batch, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { NativeConnectionTarget } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { ComposerUpload } from "./types";
import { createDraftStorage, type ConversationDraft, type DraftChanges, type DraftConflict } from "./lib/conversationDraftStorage";

export type { ConversationDraft } from "./lib/conversationDraftStorage";

type Drafts = Record<string, ConversationDraft>;

interface DraftOptions {
  onError: (message: string) => void;
}

const hasContent = (draft: ConversationDraft) => Boolean(draft.text || draft.uploads.length);

function setDraft(current: Drafts, key: string, update: (draft: ConversationDraft) => ConversationDraft) {
  const next = { ...current };
  const draft = update(current[key] ?? { text: "", uploads: [], updatedAt: Date.now() });

  if (hasContent(draft)) next[key] = draft;
  else delete next[key];

  return next;
}

function mergeDraft(source: ConversationDraft, destination?: ConversationDraft): ConversationDraft {
  if (!destination) return source;
  const text = source.text === destination.text ? source.text : [destination.text, source.text].filter(Boolean).join("\n\n");
  const uploads = new Map(destination.uploads.map(upload => [upload.id, upload]));

  for (const upload of source.uploads) uploads.set(upload.id, upload);

  return { ...destination, text, uploads: [...uploads.values()], updatedAt: Math.max(source.updatedAt, destination.updatedAt) };
}

export function createConversationDrafts(options: DraftOptions) {
  const storage = createDraftStorage(options.onError);
  const [records, setRecords] = createSignal<Drafts>(storage.legacy);
  const targets = new Map<string, NativeConnectionTarget>();
  const pending: Array<(current: Drafts) => Drafts> = [];
  const dirty: DraftChanges = new Map();
  const conflicts = new Map<string, DraftConflict>();
  const moves = new Map<string, string>();
  const discarded = new Set<string>();
  const removals = new Set<string>();
  const [isSaving, setIsSaving] = createSignal(false);
  const [isReady, setIsReady] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string>();
  let hydrated = false;
  let loading: Promise<void> | undefined;
  let saving: Promise<void> | undefined;
  let changesVersion = 0;
  let attemptedVersion = 0;

  const failed = (reason: Error | string) => {
    const message = `Could not save or restore drafts. Keep this window open and try editing again. ${String(reason)}`;

    if (untrack(saveError) !== message) options.onError(message);
    setSaveError(message);
  };

  const queueChanges = (previous: Drafts, next: Drafts) => {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[key] !== next[key]) { dirty.set(key, next[key]); changesVersion += 1; }
    }
  };

  const hydrate = () => {
    if (hydrated) return Promise.resolve();

    if (loading) return loading;
    loading = storage.load().then(stored => {
      let restored = stored;

      for (const update of pending) restored = update(restored);
      pending.length = 0;
      hydrated = true;
      queueChanges(stored, restored);
      setRecords(restored);
      setIsReady(true);
    }).finally(() => { loading = undefined; });

    return loading;
  };

  const discardConflict = (key: string) => {
    const conflict = conflicts.get(key);

    if (!conflict) return;
    storage.acceptConflict(key, conflict);
    conflicts.delete(key); dirty.delete(key); moves.delete(key); discarded.delete(key);

    if (conflict.draft?.target) targets.set(key, conflict.draft.target);
    else targets.delete(key);
    setRecords(current => {
      const next = { ...current };

      if (conflict.draft) next[key] = conflict.draft;
      else delete next[key];

      return next;
    });
  };

  const acknowledgeSaved = (changes: DraftChanges, saved: Set<string>) => {
    for (const key of saved) {
      if (!dirty.has(key) || dirty.get(key) !== changes.get(key)) continue;
      dirty.delete(key); conflicts.delete(key); moves.delete(key); discarded.delete(key); removals.delete(key);
    }
  };

  const recordConflicts = (detected: Map<string, DraftConflict>) => {
    for (const [key, conflict] of detected) {
      if (!dirty.has(key)) continue;
      conflicts.set(key, conflict);

      if (dirty.get(key) === undefined && discarded.has(key)) discardConflict(key);
    }
  };

  const persist = async () => {
    await hydrate();
    const attempted = new Set<string>();

    while (dirty.size) {
      const changes = new Map([...dirty].filter(([key]) => !attempted.has(key)));

      if (!changes.size) break;
      attemptedVersion = changesVersion;
      const result = await storage.save(changes, moves, new Set(conflicts.keys()), removals);
      acknowledgeSaved(changes, result.saved);
      recordConflicts(result.conflicts);

      for (const key of [...result.conflicts.keys(), ...result.blocked]) attempted.add(key);
    }

    if (conflicts.size) throw new Error("A draft changed in another Piop window. Unrelated drafts are saved normally. Your changes remain here; clear that draft's text and attachments to discard your version and restore the other window's saved version.");
    setSaveError(undefined);
  };

  const flush = (): Promise<void> => {
    if (saving) return saving;
    let succeeded = false;
    setIsSaving(true);
    saving = persist().then(() => { succeeded = true; }).catch(reason => { failed(reason); throw reason; }).finally(() => {
      saving = undefined;
      setIsSaving(false);

      if ((succeeded || changesVersion > attemptedVersion) && dirty.size) return flush();
    });

    return saving;
  };

  const ready = flush();
  void ready.catch(() => undefined);

  const retry = () => {
    if (!hydrated || untrack(saveError)) void flush().catch(() => undefined);
  };

  window.addEventListener("focus", retry);
  window.addEventListener("online", retry);
  onCleanup(() => {
    window.removeEventListener("focus", retry);
    window.removeEventListener("online", retry);
  });

  const updateDrafts = (update: (current: Drafts) => Drafts) => {
    const previous = untrack(records);
    const next = update(previous);

    if (hydrated && previous === next) return;
    batch(() => {
      if (hydrated) queueChanges(previous, next);
      else pending.push(update);
      setRecords(next);
    });
    void flush().catch(() => undefined);
  };

  const modify = (key: string, update: (draft: ConversationDraft) => ConversationDraft) => {
    removals.delete(key);
    updateDrafts(current => setDraft(current, key, draft => ({ ...update(draft), target: targets.get(key) ?? draft.target, updatedAt: Date.now() })));

    if (!untrack(records)[key]) { discarded.add(key); discardConflict(key); }
    else discarded.delete(key);
  };

  const setComposerDraft = (key: string, update: StateUpdate<string>) => modify(key, draft => ({ ...draft, text: update instanceof Function ? update(draft.text) : update }));
  const setComposerUploads = (key: string, update: StateUpdate<ComposerUpload[]>) => modify(key, draft => ({ ...draft, uploads: update instanceof Function ? update(draft.uploads) : update }));

  const setDraftTarget = (key: string, target: NativeConnectionTarget) => {
    targets.set(key, target);
    updateDrafts(current => {
      const draft = current[key];

      return draft && JSON.stringify(draft.target) !== JSON.stringify(target) ? { ...current, [key]: { ...draft, target } } : current;
    });
  };

  const rekeyDraft = (previousKey: string, nextKey: string, copy = false) => {
    if (previousKey === nextKey) return;
    const target = targets.get(previousKey);

    if (target && !targets.has(nextKey)) targets.set(nextKey, target);

    if (!copy) {
      targets.delete(previousKey);

      for (const [source, destination] of moves) if (destination === previousKey) moves.set(source, nextKey);
      moves.set(previousKey, nextKey);
      discarded.add(previousKey);
    }

    updateDrafts(current => {
      if (!(previousKey in current)) return current;
      const next = { ...current, [nextKey]: mergeDraft(current[previousKey], current[nextKey]) };

      if (!copy) delete next[previousKey];

      return next;
    });
  };

  const deleteLocalDraft = (key: string) => {
    updateDrafts(current => {
      const next = { ...current };
      delete next[key];
      targets.delete(key);

      return next;
    });
  };

  const removeDraft = (key: string) => { removals.add(key); discarded.delete(key); deleteLocalDraft(key); };

  const discard = (key: string) => { discarded.add(key); removals.delete(key); deleteLocalDraft(key); discardConflict(key); };

  const removeSessionDrafts = (hostId: string, sessionPath?: string, sessionId?: string) => updateDrafts(current => {
    const next = { ...current };

    for (const [key, draft] of Object.entries(current)) {
      const target = draft.target;
      const sameId = Boolean(sessionId && (key === `${hostId}:${sessionId}` || target?.sessionId === sessionId));
      const samePath = Boolean(sessionPath && target?.sessionPath === sessionPath);
      const host = target?.hostId ?? key.slice(0, key.lastIndexOf(":"));

      if (host !== hostId || !sameId && !samePath) continue;
      removals.add(key); discarded.delete(key); targets.delete(key);
      delete next[key];
    }

    return next;
  });

  const composerDrafts = createMemo(() => Object.fromEntries(Object.entries(records()).map(([key, draft]) => [key, draft.text])));
  const uploadsFor = (key: string) => records()[key]?.uploads ?? [];
  const hasDraft = (key: string) => Boolean(records()[key] && hasContent(records()[key]));

  return { records, ready, flush, isReady, isSaving, saveError, composerDrafts, uploadsFor, setComposerDraft, setComposerUploads, setDraftTarget, hasDraft, rekeyDraft, removeDraft, removeSessionDrafts, discard };
}
