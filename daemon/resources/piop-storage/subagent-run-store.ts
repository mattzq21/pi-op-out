import { isAbsolute } from "node:path";
import { Type as Schema, type Static } from "typebox";
import { Parse } from "typebox/value";
import { addSubagentRuns, hasSubagentRuns, register, saveSubagentRun, storageRoot, subagentRun, subagentRuns, transaction } from "../session-database.cjs";
import { resultNotificationId, runSchema, type SubagentRun } from "../session-broker/subagent-identity.ts";

// The subagent runs of each parent chat. Only the daemon runs these; Pi asks through its storage channel.

// The storage root of a parent chat whose subagent runs are ready.
function runStorage(file: string, sessionId: string) {
  const root = storageRoot(file);

  transaction(root, "IMMEDIATE", () => {
    if (hasSubagentRuns(root, sessionId)) return;
    register(root, sessionId, file);
    addSubagentRuns(root, sessionId);
  });

  return root;
}

const savedRunSchema = Schema.Object({ run_id: Schema.String(), run_json: Schema.String(), child_path: Schema.Union([Schema.String(), Schema.Null()]) });

function decodeRun(saved: Static<typeof savedRunSchema>, sessionId: string) {
  const run = Parse(runSchema, JSON.parse(saved.run_json));

  if (run.parentSessionId !== sessionId || resultNotificationId(run) !== saved.run_id) throw new Error("Invalid saved subagent identity");

  if (saved.child_path) run.sessionPath = saved.child_path;

  return run;
}

function readRun(root: string, sessionId: string, id: string) {
  const row = subagentRun(root, sessionId, id);

  return row ? decodeRun(Parse(savedRunSchema, row), sessionId) : undefined;
}

function storeRun(root: string, run: SubagentRun) {
  saveSubagentRun(root, run.parentSessionId, resultNotificationId(run), run.startedAt, JSON.stringify(run));
}

function mergePendingRun(root: string, run: SubagentRun) {
  const previous = readRun(root, run.parentSessionId, resultNotificationId(run));

  if (previous && previous.status !== "running" && run.status === "running") return false;

  run.deliveryIds = [...new Set([...(previous?.deliveryIds ?? []), ...(run.deliveryIds ?? [])])];

  return true;
}

function readRuns(file: string, sessionId: string) {
  return subagentRuns(runStorage(file, sessionId), sessionId).map(row => decodeRun(Parse(savedRunSchema, row), sessionId));
}

const parentSchema = Schema.Object({ sessionId: Schema.String({ minLength: 1 }), path: Schema.String({ minLength: 1 }) });

function parent(root: string, request: unknown) {
  const chat = Parse(parentSchema, request);

  if (!isAbsolute(chat.path) || !chat.path.endsWith(".jsonl")) throw new Error("Save the parent conversation before tracking a subagent");

  if (storageRoot(chat.path) !== root) throw new Error("This chat is not in the storage of this Pi");

  return chat;
}

export const OPERATIONS = {
  // Saves a run, merged with the saved one. Returns the merged delivery IDs, or null when a finished run is kept.
  persist: (root: string, request: { run: unknown }) => {
    const chat = parent(root, request);
    const run = Parse(runSchema, request.run) as SubagentRun;

    if (run.parentSessionId !== chat.sessionId) throw new Error("Subagent run belongs to another parent conversation");
    runStorage(chat.path, chat.sessionId);

    return transaction(root, "IMMEDIATE", () => {
      if (!mergePendingRun(root, run)) return null;
      storeRun(root, Parse(runSchema, run));

      return run.deliveryIds ?? [];
    });
  },
  saved: (root: string, request: unknown) => {
    const chat = parent(root, request);

    return readRuns(chat.path, chat.sessionId);
  },
};
