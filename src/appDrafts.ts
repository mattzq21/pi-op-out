import { createSignal } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { ComposerUpload } from "./types";
import { z } from "zod";
import { isMobile } from "./lib/platform";

const draftsSchema = z.record(z.string(), z.string());

function draftStorageKey() {
  try {
    const host = isMobile ? localStorage.getItem("piop-mobile-host") ?? "mobile" : "desktop";

    return `piop-conversation-drafts:v1:${host}`;
  } catch { return undefined; }
}

function restoreDrafts(key?: string): Record<string, string> {
  if (!key) return {};

  try {
    return draftsSchema.parse(JSON.parse(localStorage.getItem(key) ?? "{}"));
  } catch { return {}; }
}

function persistDraftChanges(key: string | undefined, previous: Record<string, string>, next: Record<string, string>) {
  if (!key) return;

  try {
    const stored = restoreDrafts(key);

    for (const [session, text] of Object.entries(next)) {
      if (previous[session] !== text) stored[session] = text;
    }

    for (const session of Object.keys(previous)) {
      if (!(session in next)) delete stored[session];
    }

    if (Object.keys(stored).length) localStorage.setItem(key, JSON.stringify(stored));
    else localStorage.removeItem(key);
  } catch { }
}

export function createConversationDrafts() {
  const storageKey = draftStorageKey();
  const [composerDrafts, setComposerDrafts] = createSignal(restoreDrafts(storageKey));
  const [uploadsByTransport, setUploadsByTransport] = createSignal<Map<NativeTransport, ComposerUpload[]>>(new Map());

  const updateDrafts = (update: (current: Record<string, string>) => Record<string, string>) => setComposerDrafts(current => {
    const next = update(current);
    persistDraftChanges(storageKey, current, next);

    return next;
  });

  const setComposerUploads = (ownerTransport: NativeTransport, update: StateUpdate<ComposerUpload[]>) => setUploadsByTransport((current) => {
    const next = new Map(current);
    const uploads = Array.isArray(update) ? update : update(next.get(ownerTransport) ?? []);

    if (uploads.length) next.set(ownerTransport, uploads); else next.delete(ownerTransport);

    return next;
  });

  const transportHasDraft = (owner: NativeTransport, key?: string) => Boolean(key && composerDrafts()[key]) || (uploadsByTransport().get(owner)?.length ?? 0) > 0;

  const setComposerDraft = (sessionKey: string, update: StateUpdate<string>) => updateDrafts((current) => { const value = update instanceof Function ? update(current[sessionKey] ?? "") : update;

  if (value) return { ...current, [sessionKey]: value }; const next = { ...current }; delete next[sessionKey];

  return next; });

  const rekeyDraft = (previousKey: string, nextKey: string, copy = false) => {
    if (previousKey === nextKey) return;
    updateDrafts(current => {
      if (!(previousKey in current)) return current;
      const next = { ...current, [nextKey]: current[previousKey] };

      if (!copy) delete next[previousKey];

      return next;
    });
  };

  const removeDraft = (key: string) => setComposerDraft(key, "");

  const discard = (owner: NativeTransport, key?: string) => {
    setComposerUploads(owner, []);

    if (key) removeDraft(key);
  };


  return { composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, transportHasDraft, rekeyDraft, removeDraft, discard };
}
