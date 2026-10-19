import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { open as openDatabase, register, storageRoot } from "../session-database.cjs";
import { resultNotificationId, runSchema, type SubagentRun } from "./subagent-identity.ts";

export { resultNotificationId } from "./subagent-identity.ts";

export { runSchema, type SubagentRun } from "./subagent-identity.ts";

export const SUBAGENT_RUN = "piop-subagent-run";

async function syncPath(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { await file.sync(); } finally { await file.close(); }
}

export async function syncSubagentTranscript(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) throw new Error("Subagent usage requires a saved conversation");
  await syncPath(path);
}

function sessionFile(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();

  if (!file?.endsWith(".jsonl")) throw new Error("Save the parent conversation before tracking a subagent");

  return file;
}

function runDatabase(file: string, sessionId: string) {
  const db = openDatabase(storageRoot(file));

  try {
    db.exec("BEGIN IMMEDIATE");

    if (!db.prepare("SELECT 1 FROM session_subagent_state WHERE session_id=?").get(sessionId)) {
      register(db, sessionId, file);

      db.prepare("INSERT INTO session_subagent_state VALUES (?)").run(sessionId);
    }

    db.exec("COMMIT");

    return db;
  } catch (error) { db.close(); throw error; }
}

const savedRunSchema = Schema.Object({ run_id: Schema.String(), run_json: Schema.String(), child_path: Schema.Union([Schema.String(), Schema.Null()]) });

const selectRuns = `SELECT r.run_id, r.run_json, s.session_path AS child_path FROM session_subagent_runs r
  LEFT JOIN sessions s ON s.session_id=json_extract(r.run_json, '$.sessionId')`;

function decodeRun(saved: Static<typeof savedRunSchema>, sessionId: string) {
  const run = Parse(runSchema, JSON.parse(saved.run_json));

  if (run.parentSessionId !== sessionId || resultNotificationId(run) !== saved.run_id) throw new Error("Invalid saved subagent identity");

  if (saved.child_path) run.sessionPath = saved.child_path;

  return run;
}

function readRun(db: DatabaseSync, sessionId: string, id: string) {
  const row = db.prepare(`${selectRuns} WHERE r.session_id=? AND r.run_id=?`).get(sessionId, id);

  return row ? decodeRun(Parse(savedRunSchema, row), sessionId) : undefined;
}

function storeRun(db: DatabaseSync, run: SubagentRun) {
  db.prepare(`INSERT INTO session_subagent_runs VALUES (?, ?, ?, ?) ON CONFLICT(session_id, run_id)
    DO UPDATE SET started_at=excluded.started_at, run_json=excluded.run_json`)
    .run(run.parentSessionId, resultNotificationId(run), run.startedAt, JSON.stringify(run));
}

function mergePendingRun(db: DatabaseSync, run: SubagentRun) {
  const previous = readRun(db, run.parentSessionId, resultNotificationId(run));

  if (previous && previous.status !== "running" && run.status === "running") return false;

  if (previous?.accountingPending === false && run.accountingPending) return false;
  run.deliveryIds = [...new Set([...(previous?.deliveryIds ?? []), ...(run.deliveryIds ?? [])])];

  return true;
}

export function persistSubagentRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  if (run.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Subagent run belongs to another parent conversation");
  const db = runDatabase(sessionFile(ctx), run.parentSessionId);
  let accepted = false;

  try {
    db.exec("BEGIN IMMEDIATE");
    accepted = mergePendingRun(db, run);

    if (accepted) storeRun(db, Parse(runSchema, run));
    db.exec("COMMIT");
  } finally { db.close(); }

  if (accepted) pi.appendEntry(SUBAGENT_RUN, structuredClone(run));
}

function readRuns(file: string, sessionId: string) {
  const db = runDatabase(file, sessionId);

  try {
    return db.prepare(`${selectRuns} WHERE r.session_id=? ORDER BY r.started_at, r.run_id`)
      .all(sessionId).map(row => decodeRun(Parse(savedRunSchema, row), sessionId));
  } finally { db.close(); }
}

export function savedSubagentRuns(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();

  return file ? readRuns(file, ctx.sessionManager.getSessionId()) : [];
}

export async function unresolvedSubagentRuns(file: string, sessionId: string) {
  return readRuns(file, sessionId).filter(accountingUnresolved);
}

export function accountingUnresolved(run: SubagentRun) {
  if (run.status === "running" || run.accountingPending) return true;
  const total = run.accountedTokens ?? 0;

  return total > (run.forwardedTokens ?? 0);
}

export function reportedSubagentUsage(ctx: ExtensionContext, run: SubagentRun) {
  const schema = Schema.Object({ runId: Schema.String(), total: Schema.Integer({ minimum: 0 }) });
  const runId = resultNotificationId(run);

  return ctx.sessionManager.getEntries().reduce((total, entry) => entry.type === "custom" && entry.customType === "piop-subagent-usage" && Check(schema, entry.data) && entry.data.runId === runId ? Math.max(total, entry.data.total) : total, 0);
}
