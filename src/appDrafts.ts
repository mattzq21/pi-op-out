import { createSignal } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { StateUpdate } from "./lib/solid";
import type { ComposerUpload } from "./types";

export function createConversationDrafts() {
  const [composerDrafts, setComposerDrafts] = createSignal<Record<string, string>>({});
  const [uploadsByTransport, setUploadsByTransport] = createSignal<Map<NativeTransport, ComposerUpload[]>>(new Map());

  const setComposerUploads = (ownerTransport: NativeTransport, update: StateUpdate<ComposerUpload[]>) => setUploadsByTransport((current) => {
    const next = new Map(current);
    const uploads = typeof update === "function" ? update(next.get(ownerTransport) ?? []) : update;

    if (uploads.length) next.set(ownerTransport, uploads); else next.delete(ownerTransport);

    return next;
  });

  const transportHasDraft = (owner: NativeTransport, key?: string) => Boolean(key && composerDrafts()[key]) || (uploadsByTransport().get(owner)?.length ?? 0) > 0;

  const setComposerDraft = (sessionKey: string, update: StateUpdate<string>) => setComposerDrafts((current) => { const value = typeof update === "function" ? update(current[sessionKey] ?? "") : update;

  if (value) return { ...current, [sessionKey]: value }; const next = { ...current }; delete next[sessionKey];

  return next; });

  const rekeyDraft = (previousKey: string, nextKey: string, copy = false) => {
    if (previousKey === nextKey) return;
    setComposerDrafts(current => {
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

  const copyUploads = (source: NativeTransport, destination: NativeTransport) => setComposerUploads(destination, [...(uploadsByTransport().get(source) ?? [])]);

  return { composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, transportHasDraft, rekeyDraft, removeDraft, discard, copyUploads };
}
