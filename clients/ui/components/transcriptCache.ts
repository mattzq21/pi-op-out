import { getOwner, onCleanup, type Accessor, type Owner } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import type { createTranscript, Transcript, TranscriptInput } from "./Transcript";

const LIMIT = 20;
const MEMORY_LIMIT = 512 * 1024 * 1024;
const ELEMENT_BYTES = 4 * 1024;

const size = (transcript: Transcript) => transcript.element.getElementsByTagName("*").length * ELEMENT_BYTES;

export type TranscriptCache = { take: (transport: NativeTransport, create: typeof createTranscript) => Transcript; release: (transport: NativeTransport, transcript: Transcript) => void; prepare: (transport: NativeTransport) => void; Host: () => null };

export function createTranscriptCache(background: (transport: NativeTransport) => Accessor<TranscriptInput>, limits = { count: LIMIT, bytes: MEMORY_LIMIT }): TranscriptCache {
  let owner: Owner | null = getOwner();
  let create: typeof createTranscript | undefined;
  const entries = new Map<NativeTransport, { transcript: Transcript; users: number; stop: () => void }>();

  const drop = (transport: NativeTransport) => {
    const entry = entries.get(transport);

    if (!entry) return;
    entries.delete(transport); entry.stop(); entry.transcript.dispose();
  };

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
    entry.stop = transport.onDispose(() => drop(transport));

    return entry;
  };

  onCleanup(() => { for (const transport of entries.keys()) drop(transport); });

  return {
    take(transport, draw) { create = draw; const entry = use(transport, draw); entry.users++; trim(); return entry.transcript; },
    release(transport, transcript) {
      const entry = entries.get(transport);

      if (entry?.transcript !== transcript) return;
      entry.users--;
      if (!entry.users) transcript.element.remove();
      trim();
    },
    prepare(transport) { if (create) { use(transport, create); trim(); } },
    Host() { owner = getOwner(); return null; },
  };
}
