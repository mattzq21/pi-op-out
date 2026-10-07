import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Type as Schema, type Static } from "typebox";
import { Check } from "typebox/value";
import { goalTokens } from "./goal-state.ts";

export const SUBAGENT_RUN = "piop-subagent-run";

export const runSchema = Schema.Object({
  version: Schema.Literal(1), toolCallId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), sessionPath: Schema.String(),
  hostId: Schema.String(), name: Schema.String(), task: Schema.String(), status: Schema.Union([Schema.Literal("running"), Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
  startedAt: Schema.Number(), endedAt: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.String()), apiCost: Schema.Optional(Schema.Number()),
  agent: Schema.Optional(Schema.String()), taskPath: Schema.Optional(Schema.String()),
  cwd: Schema.Optional(Schema.String()), worktree: Schema.Optional(Schema.Union([Schema.Literal("same"), Schema.Literal("new")])), branch: Schema.Optional(Schema.String()),
  offset: Schema.Optional(Schema.Integer({ minimum: 0 })), deliveryIds: Schema.Optional(Schema.Array(Schema.String())), goalId: Schema.Optional(Schema.String()),
});

const usageSchema = Schema.Object({ input: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.Number()), cacheWrite: Schema.Optional(Schema.Number()), cost: Schema.Optional(Schema.Object({ total: Schema.Optional(Schema.Number()) })) });

const transcriptEntrySchema = Schema.Object({ type: Schema.String(), timestamp: Schema.Optional(Schema.String()), usage: Schema.Optional(usageSchema), message: Schema.Optional(Schema.Unknown()) });

const descendantUsageSchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal("piop-subagent-usage"), data: Schema.Object({ tokens: Schema.Integer({ minimum: 0 }) }) });

const assistantSchema = Schema.Object({ role: Schema.Literal("assistant"), stopReason: Schema.String(), errorMessage: Schema.Optional(Schema.String()), content: Schema.Array(Schema.Unknown()), usage: Schema.Optional(usageSchema) });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

export type SubagentResponse = Static<typeof assistantSchema>;

export type SubagentRun = Static<typeof runSchema>;

let runWrites = Promise.resolve();

function serializeRun<T>(action: () => Promise<T>) {
  const next = runWrites.then(action);
  runWrites = next.then(() => {}, () => {});

  return next;
}

export function resultNotificationId(run: SubagentRun) {
  return `subagent-${createHash("sha256").update(JSON.stringify([run.parentSessionId, run.sessionId, run.toolCallId, run.startedAt])).digest("hex")}`;
}

async function syncPath(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { await file.sync(); } finally { await file.close(); }
}

function journalDirectory(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path?.endsWith(".jsonl")) throw new Error("Save the parent conversation before tracking a subagent");

  return join(path.replace(/\.jsonl$/, ".snapshots"), "subagent-runs");
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Subagent recovery storage must be a directory");
}

async function readPendingRun(ctx: ExtensionContext, run: SubagentRun) {
  try {
    const saved = JSON.parse(await readFile(join(journalDirectory(ctx), `${resultNotificationId(run)}.json`), "utf8"));

    if (!Check(runSchema, saved) || resultNotificationId(saved) !== resultNotificationId(run)) throw new Error("Invalid saved subagent identity");

    return saved;
  } catch (error) { if (!Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) throw error; }
}

async function mergePendingRun(ctx: ExtensionContext, run: SubagentRun) {
  let previous = ownedSubagentRuns(ctx).find(item => resultNotificationId(item) === resultNotificationId(run));
  const saved = await readPendingRun(ctx, run);

  if (saved && (!previous || previous.status === "running")) previous = saved;

  if (previous && previous.status !== "running" && run.status === "running") return false;
  run.deliveryIds = [...new Set([...(previous?.deliveryIds ?? []), ...(run.deliveryIds ?? [])])];

  return true;
}

async function writeSubagentRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  if (run.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Subagent run belongs to another parent conversation");

  if (!await mergePendingRun(ctx, run)) return;
  const directory = journalDirectory(ctx);
  await privateDirectory(dirname(directory)); await privateDirectory(directory);
  const destination = join(directory, `${resultNotificationId(run)}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try { await file.writeFile(JSON.stringify(run)); await file.sync(); } finally { await file.close(); }

    await rename(temporary, destination);
    await syncPath(directory); await syncPath(dirname(directory)); await syncPath(dirname(dirname(directory)));
  } finally { await rm(temporary, { force: true }); }

  pi.appendEntry(SUBAGENT_RUN, structuredClone(run));
}

export function persistSubagentRun(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun) {
  return serializeRun(() => writeSubagentRun(pi, ctx, run));
}

export async function savedSubagentRuns(ctx: ExtensionContext) {
  const runs = new Map(ownedSubagentRuns(ctx).map(run => [resultNotificationId(run), run]));

  if (!ctx.sessionManager.getSessionFile()) return [...runs.values()];
  let names: string[];

  try { names = await readdir(journalDirectory(ctx)); }
  catch (error) { if (Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) return [...runs.values()]; throw error; }

  for (const name of names.filter(name => /^subagent-[a-f0-9]{64}\.json$/.test(name))) {
    const run = JSON.parse(await readFile(join(journalDirectory(ctx), name), "utf8"));

    if (!Check(runSchema, run) || name !== `${resultNotificationId(run)}.json`) throw new Error("Invalid saved subagent run");

    if (run.parentSessionId !== ctx.sessionManager.getSessionId()) continue;
    mergeSavedRun(runs, run);
  }

  return [...runs.values()].sort((left, right) => left.startedAt - right.startedAt || resultNotificationId(left).localeCompare(resultNotificationId(right)));
}

function mergeSavedRun(runs: Map<string, SubagentRun>, run: SubagentRun) {
  const previous = runs.get(resultNotificationId(run));

  if (run.status === "running" && previous && previous.status !== "running") return;
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
  await rm(join(directory, `${resultNotificationId(run)}.json`), { force: true });

  try { await syncPath(directory); }
  catch (error) { if (!Check(Schema.Object({ code: Schema.Literal("ENOENT") }), error)) throw error; }
}

export function forgetSubagentRun(ctx: ExtensionContext, run: SubagentRun) {
  return serializeRun(() => removeSubagentRun(ctx, run));
}

export function completedSubagentOutput(last: SubagentResponse | undefined) {
  if (!last) throw new Error("Subagent produced no assistant response; inspect its transcript");

  if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `Subagent ${last.stopReason}`);

  if (last.stopReason === "toolUse") throw new Error("Subagent stopped before completing its task");
  const output = last.content.flatMap((part) => Check(textSchema, part) ? [part.text] : []).join("\n") || "(No text returned; inspect the saved transcript.)";

  return output.length > 16_000 ? `${output.slice(0, 16_000)}\n[Result truncated. Full conversation is saved in the child transcript.]` : output;
}

function subagentEntryCost(usage: Static<typeof usageSchema> | undefined) {
  const amount = usage?.cost?.total;

  return amount !== undefined && Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function relevantEntry(line: string, run: SubagentRun) {
  let entry;

  try { entry = JSON.parse(line); } catch { return; }

  if (!Check(transcriptEntrySchema, entry)) return;

  if (run.offset === undefined && (!entry.timestamp || Date.parse(entry.timestamp) < run.startedAt)) return;

  return entry;
}

export async function subagentCompletion(run: SubagentRun, reportUsage: (tokens: number) => Promise<void>) {
  let last: SubagentResponse | undefined;
  let cost = 0;
  let tokens = 0;
  const input = createReadStream(run.sessionPath, { start: run.offset ?? 0 });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const entry = relevantEntry(line, run);

      if (!entry) continue;

      if (Check(descendantUsageSchema, entry)) { tokens += entry.data.tokens; continue; }

      if (entry.type !== "message") { tokens += goalTokens(entry.usage); cost += subagentEntryCost(entry.usage); continue; }

      if (Check(Schema.Object({ role: Schema.Literal("user") }), entry.message)) last = undefined;

      if (!Check(assistantSchema, entry.message)) continue;
      last = entry.message;
      cost += subagentEntryCost(last.usage);
      tokens += goalTokens(last.usage);
    }
  } finally { lines.close(); input.destroy(); await reportUsage(tokens); }

  run.apiCost = cost;

  return last;
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

export async function persistSubagentUsage(pi: ExtensionAPI, ctx: ExtensionContext, run: SubagentRun, total: number, tokens: number) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) throw new Error("Subagent usage requires a saved parent conversation");
  pi.appendEntry("piop-subagent-usage", { runId: resultNotificationId(run), total, tokens });
  await syncPath(path);
}
