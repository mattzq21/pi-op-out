import { OPERATIONS as transcript } from "./transcript-writes.ts";
import { OPERATIONS as chats } from "./new-chats.ts";
import { OPERATIONS as mailbox } from "./mailbox-store.ts";
import { OPERATIONS as subagents } from "./subagent-run-store.ts";
import { OPERATIONS as settings } from "./settings-writes.ts";

// Every storage change that Pi asks the daemon for, by area. A request names one as `area.name`.
export const AREAS = { transcript, chats, mailbox, subagents, settings };

export function storageOperation(name: unknown) {
  const [area, operation] = typeof name === "string" ? name.split(".") : [];
  const operations = Object.hasOwn(AREAS, area) ? AREAS[area as keyof typeof AREAS] : undefined;
  if (!operations || !Object.hasOwn(operations, operation)) throw new Error("Unknown storage request: " + String(name));
  return { area, name: operation, run: operations[operation as keyof typeof operations] };
}
