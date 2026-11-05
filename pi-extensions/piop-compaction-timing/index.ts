import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMING_ENTRY = "piop-compaction-timing";

export default function compactionTiming(pi: ExtensionAPI) {
  let startedAt: number | undefined;

  pi.on("session_before_compact", () => { startedAt = Date.now(); });
  pi.on("session_compact_failed", () => { startedAt = undefined; });
  pi.on("session_compact", event => {
    if (startedAt === undefined) throw new Error("A compaction ended without a recorded start");
    pi.appendEntry(TIMING_ENTRY, { compactionId: event.compactionEntry.id, startedAt });
    startedAt = undefined;
  });
}
