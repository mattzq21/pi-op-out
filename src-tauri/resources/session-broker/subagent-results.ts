import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Type as Schema, type Static } from "typebox";
import { Check } from "typebox/value";
import { goalTokens } from "./goal-state.ts";
import { resultNotificationId } from "./subagent-identity.ts";

export { resultNotificationId } from "./subagent-identity.ts";

export const SUBAGENT_RUN = "piop-subagent-run";

export const runSchema = Schema.Object({
  version: Schema.Literal(1), toolCallId: Schema.String(), parentSessionId: Schema.String(), sessionId: Schema.String(), sessionPath: Schema.String(),
  hostId: Schema.String(), name: Schema.String(), task: Schema.String(), status: Schema.Union([Schema.Literal("running"), Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
  startedAt: Schema.Number(), endedAt: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.String()), apiCost: Schema.Optional(Schema.Number()),
  agent: Schema.Optional(Schema.String()), taskPath: Schema.Optional(Schema.String()),
  cwd: Schema.Optional(Schema.String()), worktree: Schema.Optional(Schema.Union([Schema.Literal("same"), Schema.Literal("new")])), branch: Schema.Optional(Schema.String()),
  offset: Schema.Optional(Schema.Integer({ minimum: 0 })), deliveryIds: Schema.Optional(Schema.Array(Schema.String())), goalId: Schema.Optional(Schema.String()),
  accountingPending: Schema.Optional(Schema.Boolean()),
});

const usageSchema = Schema.Object({ input: Schema.Optional(Schema.Number()), output: Schema.Optional(Schema.Number()), cacheWrite: Schema.Optional(Schema.Number()), cost: Schema.Optional(Schema.Object({ total: Schema.Optional(Schema.Number()) })) });

const transcriptEntrySchema = Schema.Object({ type: Schema.String(), timestamp: Schema.Optional(Schema.String()), usage: Schema.Optional(usageSchema), message: Schema.Optional(Schema.Unknown()) });

const descendantUsageSchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal("piop-subagent-usage"), data: Schema.Object({ tokens: Schema.Integer({ minimum: 0 }) }) });

const assistantSchema = Schema.Object({ role: Schema.Literal("assistant"), timestamp: Schema.Optional(Schema.Number()), stopReason: Schema.String(), errorMessage: Schema.Optional(Schema.String()), content: Schema.Array(Schema.Unknown()), usage: Schema.Optional(usageSchema) });

const responseUsageSchema = Schema.Object({ type: Schema.Literal("custom"), customType: Schema.Literal("piop-subagent-response-usage"), data: Schema.Object({ key: Schema.String(), tokens: Schema.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }) });

const textSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

export type SubagentResponse = Static<typeof assistantSchema>;

export type SubagentRun = Static<typeof runSchema>;

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

function journalDirectory(ctx: ExtensionContext) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path?.endsWith(".jsonl")) throw new Error("Save the parent conversation before tracking a subagent");

  return runJournalDirectory(path);
}

function runJournalDirectory(path: string) {
  if (!path.endsWith(".jsonl")) throw new Error("Subagent recovery requires a saved conversation");

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

  return [...runs.values()].filter(run => run.status === "running" || run.accountingPending);
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

type SubagentTranscript = Pick<SubagentRun, "sessionPath" | "offset" | "startedAt">;

function relevantEntry(line: string, run: SubagentTranscript) {
  let entry;

  try { entry = JSON.parse(line); } catch { return; }

  if (!Check(transcriptEntrySchema, entry)) return;

  if (run.offset === undefined && (!entry.timestamp || Date.parse(entry.timestamp) < run.startedAt)) return;

  return entry;
}

function responseUsageKey(timestamp: number | undefined, tokens: number) {
  return JSON.stringify([timestamp, tokens]);
}

function unrecordedResponse(message: SubagentResponse, recorded: Map<string, number>) {
  const tokens = goalTokens(message.usage);
  const key = responseUsageKey(message.timestamp, tokens);
  const remaining = recorded.get(key) ?? 0;

  if (!remaining) return tokens;
  recorded.set(key, remaining - 1);

  return 0;
}

async function scanSubagentTranscript(run: SubagentTranscript, reportUsage: (tokens: number) => Promise<void>) {
  let last: SubagentResponse | undefined;
  let cost = 0;
  let tokens = 0;
  const recorded = new Map<string, number>();
  const input = createReadStream(run.sessionPath, { start: run.offset ?? 0 });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const entry = relevantEntry(line, run);

      if (!entry) continue;

      if (Check(descendantUsageSchema, entry)) { tokens += entry.data.tokens; continue; }

      if (Check(responseUsageSchema, entry)) {
        tokens += entry.data.tokens;
        recorded.set(entry.data.key, (recorded.get(entry.data.key) ?? 0) + 1);
        continue;
      }

      if (entry.type !== "message") { tokens += goalTokens(entry.usage); cost += subagentEntryCost(entry.usage); continue; }

      if (Check(Schema.Object({ role: Schema.Literal("user") }), entry.message)) last = undefined;

      if (!Check(assistantSchema, entry.message)) continue;
      last = entry.message;
      cost += subagentEntryCost(last.usage);
      tokens += unrecordedResponse(last, recorded);
    }
  } finally { lines.close(); input.destroy(); await reportUsage(tokens); }

  return { last, cost };
}

export async function subagentUsageTotal(run: SubagentTranscript) {
  let total = 0;
  await scanSubagentTranscript(run, async tokens => { total = tokens; });

  return total;
}

export async function subagentCompletion(run: SubagentRun, reportUsage: (tokens: number) => Promise<void>) {
  const { last, cost } = await scanSubagentTranscript(run, reportUsage);
  run.apiCost = cost;

  return last;
}

export async function persistSubagentResponseUsage(pi: ExtensionAPI, ctx: ExtensionContext, timestamp: number, tokens: number) {
  const path = ctx.sessionManager.getSessionFile();

  if (!path) throw new Error("Subagent usage requires a saved conversation");
  pi.appendEntry("piop-subagent-response-usage", { key: responseUsageKey(timestamp, tokens), tokens });
  await syncPath(path);
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
  pi.appendEntry("piop-subagent-usage", { version: 1, runId: resultNotificationId(run), goalId: run.goalId, total, tokens });
  await syncPath(path);
}
