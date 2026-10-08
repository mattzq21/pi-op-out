import { createSignal } from "solid-js";
import { z } from "zod";
import type { ChatNoteTarget } from "./useNotes";

const prefix = "piop-chat-note:";

const targetSchema = z.tuple([z.string(), z.string()]);

const draftSchema = z.object({ content: z.string(), version: z.string() });

export interface LegacyNoteDraft {
  target: ChatNoteTarget;
  key: string;
  stored: string;
  content?: string;
  baseVersion?: string;
}

const [revision, setRevision] = createSignal(0);

const changed = () => setRevision(previous => previous + 1);

window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith(prefix)) changed();
});

const storageKey = (target: ChatNoteTarget) => prefix + JSON.stringify([target.hostId, target.sessionId]);

function decodeDraft(target: ChatNoteTarget, key: string, stored: string): LegacyNoteDraft {
  try {
    const result = draftSchema.safeParse(JSON.parse(stored));

    if (result.success) return { target, key, stored, content: result.data.content, baseVersion: result.data.version };
  } catch { }

  return { target, key, stored };
}

export function readLegacyNoteDraft(target: ChatNoteTarget) {
  revision();

  try {
    const key = storageKey(target);
    const stored = localStorage.getItem(key);

    if (stored !== null) return decodeDraft(target, key, stored);
  } catch { }
}

function readTarget(key: string) {
  if (!key.startsWith(prefix)) return;

  try {
    const result = targetSchema.safeParse(JSON.parse(key.slice(prefix.length)));

    if (result.success) return { hostId: result.data[0], sessionId: result.data[1] };
  } catch { }
}

export function legacyNoteDrafts() {
  revision();
  const drafts: LegacyNoteDraft[] = [];

  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);

      if (key === null) continue;
      const target = readTarget(key);

      if (!target) continue;
      const stored = localStorage.getItem(key);

      if (stored !== null) drafts.push(decodeDraft(target, key, stored));
    }
  } catch { }

  return drafts;
}

export function legacyNoteDraftCurrent(draft: LegacyNoteDraft) {
  try { if (localStorage.getItem(draft.key) === draft.stored) return true; } catch { }

  changed();

  return false;
}

export function retireLegacyNoteDraft(draft: LegacyNoteDraft) {
  try {
    if (!legacyNoteDraftCurrent(draft)) return false;
    localStorage.removeItem(draft.key);
  } catch { return false; }

  changed();

  return true;
}
