import { OPERATIONS as transcript, PUBLICATION_LOCKED } from "./transcript-writes.mjs";
import { OPERATIONS as chats } from "./new-chats.cjs";
import { OPERATIONS as mailbox } from "./mailbox-store.ts";
import { OPERATIONS as subagents } from "./subagent-run-store.ts";
import { OPERATIONS as records } from "./chat-record-writes.mjs";
import { OPERATIONS as settings } from "./settings-writes.mjs";

// Every storage change that Pi asks the daemon for, by area. A request names one as `area.name`.
// The transcript changes in PUBLICATION_LOCKED run under the shared reference publication lock.
export const AREAS = { transcript, chats, mailbox, subagents, records, settings };

export function storageOperation(name) {
  const [area, operation] = typeof name === "string" ? name.split(".") : [];
  const operations = Object.hasOwn(AREAS, area) ? AREAS[area] : undefined;
  if (!operations || !Object.hasOwn(operations, operation)) throw new Error("Unknown storage request: " + String(name));
  return { area, name: operation, run: operations[operation], referenceLocked: area === "transcript" && PUBLICATION_LOCKED.has(operation) };
}
