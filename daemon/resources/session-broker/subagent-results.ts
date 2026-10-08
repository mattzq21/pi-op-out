import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { constants, createReadStream, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";
import { resultNotificationId, runSchema, type SubagentRun } from "./subagent-identity.ts";

export { resultNotificationId } from "./subagent-identity.ts";

export { runSchema, type SubagentRun } from "./subagent-identity.ts";

export const SUBAGENT_RUN = "piop-subagent-run";

let runWrites = Promise.resolve();

function serializeRun<T>(action: () => Promise<T>) {
  const next = runWrites.then(action);
  runWrites = next.then(() => {}, () => {});

  return next;
}

async function syncPath(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { await file.sync(); } finally { await file.close(); }
}

export async function syncSubagentTranscript(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) throw new Error("Subagent usage requires a saved conversation");
  await syncPath(path);
}

function journalDirectory(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path?.endsWith(".jsonl")) throw new Error("Save the parent conversation before tracking a subagent");

  return runJournalDirectory(path);
}

function runJournalDirectory(path: string) {
  if (!path.endsWith(".jsonl")) throw new Error("Subagent recovery requires a saved conversation");

  return join(path.replace(/\.jsonl$/, ".snapshots"), "subagent-runs");
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Subagent recovery storage must be a directory");
}

function readPendingRun(ctx: ExtensionContext, run: SubagentRun) {
  try {
    const saved = JSON.parse(readFileSync(join(journalDirectory(ctx), `${resultNotificationId(run)}.json`), "utf8"));

    if (!Check(runSchema, saved) || resultNotificationId(saved) !== resultNotificationId(run)) throw new Error("Invalid saved subagent identity");

    return saved;
  } catch (error) { if (!Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) throw error; }
}

function previousRun(ctx: ExtensionContext, run: SubagentRun) {
  let previous = ownedSubagentRuns(ctx).find(item => resultNotificationId(item) === resultNotificationId(run));
  const saved = readPendingRun(ctx, run);

  if (saved && (!previous || previous.status === "running")) previous = saved;

  return previous;
}

function mergePendingRun(ctx: ExtensionContext, run: SubagentRun) {
  const previous = previousRun(ctx, run);

  if (previous && previous.status !== "running" && run.status === "running") return false;

  if (previous?.accountingPending === false && run.accountingPending) return false;
  run.deliveryIds = [...new Set([...(previous?.deliveryIds ?? []), ...(run.deliveryIds ?? [])])];

  return true;
}

function syncRunPath(path: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { fsyncSync(file); } finally { closeSync(file); }
}

function writeSubagentRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  if (run.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Subagent run belongs to another parent conversation");

  if (!mergePendingRun(ctx, run)) return;
  const directory = journalDirectory(ctx);
  privateDirectory(dirname(directory)); privateDirectory(directory);
  const destination = join(directory, `${resultNotificationId(run)}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx", 0o600);

  try {
    try { writeFileSync(file, JSON.stringify(run)); fsyncSync(file); } finally { closeSync(file); }

    renameSync(temporary, destination);
    syncRunPath(directory); syncRunPath(dirname(directory)); syncRunPath(dirname(dirname(directory)));
  } finally { rmSync(temporary, { force: true }); }

  pi.appendEntry(SUBAGENT_RUN, structuredClone(run));
}

export function persistSubagentRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  writeSubagentRun(pi, ctx, run);
}

export async function savedSubagentRuns(ctx: ExtensionContext) {
  const runs = new Map(ownedSubagentRuns(ctx).map(run => [resultNotificationId(run), run]));
  const path = ctx.sessionManager.getSessionFile();

  if (path) await mergeRunJournals(path, ctx.sessionManager.getSessionId(), runs);

  return [...runs.values()].sort((left, right) => left.startedAt - right.startedAt || resultNotificationId(left).localeCompare(resultNotificationId(right)));
}

async function mergeRunJournals(path: string, sessionId: string, runs: Map<string, SubagentRun>) {
  const directory = runJournalDirectory(path);
  let names: string[];

  try { names = await readdir(directory); }
  catch (error) { if (Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) return; throw error; }

  for (const name of names.filter(name => /^subagent-[a-f0-9]{64}\.json$/.test(name))) {
    const run = JSON.parse(await readFile(join(directory, name), "utf8"));

    if (!Check(runSchema, run) || name !== `${resultNotificationId(run)}.json`) throw new Error("Invalid saved subagent run");

    if (run.parentSessionId !== sessionId) continue;
    mergeSavedRun(runs, run);
  }
}

export async function unresolvedSubagentRuns(path: string, sessionId: string) {
  const runs = new Map<string, SubagentRun>();
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header = false;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;

      if (!header) {
        if (!Check(Schema.Object({ type: Schema.Literal("session"), id: Schema.Literal(sessionId) }), JSON.parse(line))) throw new Error("Subagent recovery transcript identity changed");
        header = true;
      }

      collectSubagentRun(line, sessionId, runs);
    }
  } finally { lines.close(); input.destroy(); }

  if (!header) throw new Error("Subagent recovery transcript is empty");
  await mergeRunJournals(path, sessionId, runs);

  return [...runs.values()].filter(accountingUnresolved);
}

export function accountingUnresolved(run: SubagentRun) {
  if (run.status === "running" || run.accountingPending) return true;
  const total = run.accountedTokens ?? 0;

  return total > (run.forwardedTokens ?? 0) || Boolean(run.goalId && total > (run.goalTokens ?? 0));
}

function collectSubagentRun(line: string, sessionId: string, runs: Map<string, SubagentRun>) {
  const entrySchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal(SUBAGENT_RUN), data: Schema.Unknown() });
  const entry = JSON.parse(line);

  if (!Check(entrySchema, entry)) return;

  if (!Check(runSchema, entry.data)) throw new Error("Invalid saved descendant run");

  if (entry.data.parentSessionId === sessionId) runs.set(resultNotificationId(entry.data), entry.data);
}

function mergeSavedRun(runs: Map<string, SubagentRun>, run: SubagentRun) {
  const previous = runs.get(resultNotificationId(run));

  if (run.status === "running" && previous && previous.status !== "running") return;

  if (previous?.accountingPending === false && run.accountingPending) return;
  runs.set(resultNotificationId(run), run);
}

async function removeSubagentRun(ctx: ExtensionContext, run: SubagentRun) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) return;

  let content: string;

  try { content = await readFile(path, "utf8"); }
  catch (error) { if (Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) return; throw error; }

  const lines = content.split("\n");
  const schema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal(SUBAGENT_RUN), data: runSchema });

  const saved = lines.some(line => {
    let entry;

    try { entry = JSON.parse(line); } catch { return false; }

    return Check(schema, entry) && JSON.stringify(entry.data) === JSON.stringify(run);
  });

  if (!saved) return;

  await syncPath(path);
  const directory = journalDirectory(ctx);
  const pending = readPendingRun(ctx, run);

  if (pending && JSON.stringify(pending) !== JSON.stringify(run)) return;
  rmSync(join(directory, `${resultNotificationId(run)}.json`), { force: true });

  try { await syncPath(directory); }
  catch (error) { if (!Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) throw error; }
}

export function forgetSubagentRun(ctx: ExtensionContext, run: SubagentRun) {
  return serializeRun(() => removeSubagentRun(ctx, run));
}

export function ownedSubagentRuns(ctx: ExtensionContext) {
  const parentSessionId = ctx.sessionManager.getSessionId();

  return [...new Map(ctx.sessionManager.getEntries().flatMap<[string, SubagentRun]>(entry => {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_RUN || !Check(runSchema, entry.data)) return [];
    const run = entry.data;

    return run.parentSessionId === parentSessionId ? [[resultNotificationId(run), structuredClone(run)]] : [];
  })).values()].sort((left, right) => left.startedAt - right.startedAt || resultNotificationId(left).localeCompare(resultNotificationId(right)));
}

export function hasSubagentResult(ctx: ExtensionContext, run: SubagentRun) {
  const detailsSchema = Schema.Object({ runs: Schema.Array(runSchema) });

  return ctx.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === "piop-subagent-result" && Check(detailsSchema, entry.details)
    && entry.details.runs.some(previous => resultNotificationId(previous) === resultNotificationId(run)));
}

export function reportedSubagentUsage(ctx: ExtensionContext, run: SubagentRun) {
  const schema = Schema.Object({ runId: Schema.String(), total: Schema.Integer({ minimum: 0 }) });
  const runId = resultNotificationId(run);

  return ctx.sessionManager.getEntries().reduce((total, entry) => entry.type === "custom" && entry.customType === "piop-subagent-usage" && Check(schema, entry.data) && entry.data.runId === runId ? Math.max(total, entry.data.total) : total, 0);
}
