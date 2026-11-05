import { OPERATIONS as transcript, PUBLICATION_LOCKED, GOAL_ASSETS_LOCKED as TRANSCRIPT_GOAL_ASSETS } from "./transcript-writes.mjs";
import { OPERATIONS as publication, GOAL_ASSETS_LOCKED as PUBLICATION_GOAL_ASSETS, releaseClaims } from "./publication-writes.mjs";
import { OPERATIONS as mailbox } from "./mailbox-store.ts";
import { OPERATIONS as subagents } from "./subagent-run-store.ts";
import { OPERATIONS as records } from "./chat-record-writes.mjs";
import { OPERATIONS as settings } from "./settings-writes.mjs";

// Every storage change that Pi asks the daemon for, by area. A request names one as `area.name`.
// The transcript changes in PUBLICATION_LOCKED run under the shared reference publication lock. The changes in
// GOAL_ASSETS run under the goal asset lock, which the daemon takes for them without blocking.
export const AREAS = { transcript, publication, mailbox, subagents, records, settings };

const GOAL_ASSETS = { transcript: TRANSCRIPT_GOAL_ASSETS, publication: PUBLICATION_GOAL_ASSETS };

export function storageOperation(name) {
  const [area, operation] = typeof name === "string" ? name.split(".") : [];
  const operations = Object.hasOwn(AREAS, area) ? AREAS[area] : undefined;
  if (!operations || !Object.hasOwn(operations, operation)) throw new Error("Unknown storage request: " + String(name));
  return { area, name: operation, run: operations[operation], referenceLocked: area === "transcript" && PUBLICATION_LOCKED.has(operation), goalAssetsLocked: GOAL_ASSETS[area]?.has(operation) === true };
}

export { releaseClaims };
