import { getOwner, onCleanup, type Accessor, type Owner } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import type { createTranscript, Transcript, TranscriptInput } from "./Transcript";

/** The number of chats whose turns stay drawn. */
const LIMIT = 20;
/** The memory that the drawn turns of all chats may use. */
const MEMORY_LIMIT = 512 * 1024 * 1024;
/** The memory of one drawn element of a turn, with the state that updates it: an estimate from real chats in Chromium and WebKitGTK. */
const ELEMENT_BYTES = 4 * 1024;

const size = (transcript: Transcript) => transcript.element.getElementsByTagName("*").length * ELEMENT_BYTES;

/**
 * The drawn turns of the recent chats, so a chat opens without drawing them again.
 * take and release: a view shows and stops showing the turns of a chat. take gets the code that draws turns from the view, so the app loads it with the view.
 * prepare: draws the turns of a chat that no view shows, such as a chat with a new answer. Before a view has shown a chat, it does nothing.
 * Host: renders inside the app's contexts, so the turns get them.
 */
export type TranscriptCache = { take: (transport: NativeTransport, create: typeof createTranscript) => Transcript; release: (transport: NativeTransport, transcript: Transcript) => void; prepare: (transport: NativeTransport) => void; Host: () => null };

/** background: makes the input of a chat's turns while no view shows them. It runs inside the turns. */
export function createTranscriptCache(background: (transport: NativeTransport) => Accessor<TranscriptInput>, limits = { count: LIMIT, bytes: MEMORY_LIMIT }): TranscriptCache {
  let owner: Owner | null = getOwner();
  let create: typeof createTranscript | undefined;
  /** Least recently used first. users: the views that show the turns now. */
  const entries = new Map<NativeTransport, { transcript: Transcript; users: number; stop: () => void }>();

  const drop = (transport: NativeTransport) => {
    const entry = entries.get(transport);

    if (!entry) return;
    entries.delete(transport); entry.stop(); entry.transcript.dispose();
  };

  /** Drops the least recently used chats that no view shows, until the count and the memory are in their limits. */
  const trim = () => {
    let total = 0;
    const sizes = new Map<NativeTransport, number>();

    for (const [transport, entry] of entries) { const bytes = size(entry.transcript); sizes.set(transport, bytes); total += bytes; }
    for (const [transport, entry] of entries) {
      if (entries.size <= limits.count && total <= limits.bytes) return;
      if (!entry.users) { total -= sizes.get(transport) ?? 0; drop(transport); }
    }
  };

  const use = (transport: NativeTransport, draw: typeof createTranscript) => {
    const existing = entries.get(transport);

    if (existing) { entries.delete(transport); entries.set(transport, existing); return existing; }
    const entry = { transcript: draw(transport, () => background(transport), owner), users: 0, stop: () => undefined as void };
    entries.set(transport, entry);
    // A closed chat's turns go with it.
    entry.stop = transport.onDispose(() => drop(transport));

    return entry;
  };

  onCleanup(() => { for (const transport of [...entries.keys()]) drop(transport); });

  return {
    take(transport, draw) { create = draw; const entry = use(transport, draw); entry.users++; trim(); return entry.transcript; },
    release(transport, transcript) {
      const entry = entries.get(transport);

      if (entry?.transcript !== transcript) return;
      entry.users--;
      // A view that no longer shows the turns lets its page go.
      if (!entry.users) transcript.element.remove();
      trim();
    },
    prepare(transport) { if (create) { use(transport, create); trim(); } },
    Host() { owner = getOwner(); return null; },
  };
}
