import { batch, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { NativeConnectionTarget } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { ComposerUpload } from "./types";
import { createDraftStorage, type ConversationDraft, type DraftChanges } from "./lib/conversationDraftStorage";

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
  const [isSaving, setIsSaving] = createSignal(false);
  const [isReady, setIsReady] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string>();
  let hydrated = false;
  let loading: Promise<void> | undefined;
  let saving: Promise<void> | undefined;

  const failed = (reason: Error | string) => {
    const message = `Could not save or restore drafts. Keep this window open and try editing again. ${String(reason)}`;

    if (untrack(saveError) !== message) options.onError(message);
    setSaveError(message);
  };

  const queueChanges = (previous: Drafts, next: Drafts) => {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[key] !== next[key]) dirty.set(key, next[key]);
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

  const persist = async () => {
    await hydrate();

    while (dirty.size) {
      const changes = new Map(dirty);
      await storage.save(changes);

      for (const [key, draft] of changes) {
        if (dirty.get(key) === draft) dirty.delete(key);
      }
    }

    setSaveError(undefined);
  };

  const flush = (): Promise<void> => {
    if (saving) return saving;
    let succeeded = false;
    setIsSaving(true);
    saving = persist().then(() => { succeeded = true; }).catch(reason => { failed(reason); throw reason; }).finally(() => {
      saving = undefined;
      setIsSaving(false);

      if (succeeded && dirty.size) return flush();
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

  const modify = (key: string, update: (draft: ConversationDraft) => ConversationDraft) => updateDrafts(current => setDraft(current, key, draft => ({ ...update(draft), target: targets.get(key) ?? draft.target, updatedAt: Date.now() })));

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

    if (!copy) targets.delete(previousKey);
    updateDrafts(current => {
      if (!(previousKey in current)) return current;
      const next = { ...current, [nextKey]: mergeDraft(current[previousKey], current[nextKey]) };

      if (!copy) delete next[previousKey];

      return next;
    });
  };

  const removeDraft = (key: string) => updateDrafts(current => {
    const next = { ...current };
    delete next[key];
    targets.delete(key);

    return next;
  });

  const composerDrafts = createMemo(() => Object.fromEntries(Object.entries(records()).map(([key, draft]) => [key, draft.text])));
  const uploadsFor = (key: string) => records()[key]?.uploads ?? [];
  const hasDraft = (key: string) => Boolean(records()[key] && hasContent(records()[key]));

  return { records, ready, flush, isReady, isSaving, saveError, composerDrafts, uploadsFor, setComposerDraft, setComposerUploads, setDraftTarget, hasDraft, rekeyDraft, removeDraft, discard: removeDraft };
}
