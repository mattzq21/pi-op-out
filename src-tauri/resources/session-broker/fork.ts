import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, realpath, mkdir, rmdir, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { currentHost } from "./client.ts";
import { writeSessionFile } from "./session-file.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { pinPromptHistory, removePinnedCheckpoints, type PinnedCheckpoint } from "../piop-diff-watch/pin-checkpoints.ts";
import { publishFork, ForkPublicationPending } from "../piop-diff-watch/fork-publication.ts";
import { registerPreparedCheckpoints } from "../piop-diff-watch/fork-preparation.ts";

export type ForkOptions = { cwd?: string; worktree?: string; entryId?: string };

export const createdWorktreeSchema = Type.Object({ path: Type.String(), branch: Type.String(), setupError: Type.Optional(Type.Union([Type.String(), Type.Null()])) });

export type CreatedWorktree = Static<typeof createdWorktreeSchema>;

const fileErrorSchema = Type.Object({ code: Type.String() });

const responseIdsSchema = Type.Object({ responseEntryIds: Type.Array(Type.String()) });

function inheritGoal(ctx: ExtensionContext, retained: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, timestamp: string) {
  const goal = [...ctx.sessionManager.getEntries()].reverse().find(entry => entry.type === "custom" && entry.customType === "piop-goal");

  if (goal?.type === "custom") retained.push({ ...structuredClone(goal), id: randomUUID().slice(0, 8), parentId: retained.at(-1)?.id ?? null, timestamp });
}

export async function forkConversation(ctx: ExtensionContext, options: ForkOptions, createWorktree: (name: string) => Promise<CreatedWorktree>) {
  const retained = structuredClone(forkHistory(ctx, options.entryId));
  const header = ctx.sessionManager.getHeader();
  const source = ctx.sessionManager.getSessionFile();

  if (!header || !source) throw new Error("Save this conversation before forking it");
  let cwd = await forkDirectory(ctx.cwd, options);
  const worktree = options.worktree ? await createWorktree(options.worktree) : undefined;

  if (worktree) cwd = worktree.path;
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  inheritGoal(ctx, retained, timestamp);
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  let created = false;
  let checkpoints: PinnedCheckpoint[] = [];

  try {
    await registerPreparedCheckpoints(sessionId, header.cwd, retained);
    checkpoints = await pinPromptHistory(header.cwd, sessionId, retained);
    const entries = [{ ...header, id: sessionId, timestamp, cwd, parentSession: source }, ...retained];

    if (process.env.PIOP_FORK_PREPARATION_DIRECTORY) {
      await writeSessionFile(sessionPath, entries);
      created = true;
      await copyRetainedDiffs(source, sessionPath, new Set(retained.map(entry => entry.id)));
    } else await publishFork({ source, destination: sessionPath, sessionId, content: entries.map(entry => JSON.stringify(entry)).join("\n") + "\n" });

  } catch (error) {
    if (error instanceof ForkPublicationPending) throw error;

    if (created) {
      await rm(sessionPath, { force: true });
      await rm(sessionPath.replace(/\.jsonl$/, ".diffs.json"), { force: true });
    }

    await removePinnedCheckpoints(checkpoints);
    await cleanupForkDirectory(cwd, options);

    if (worktree) throw new Error(`Worktree kept at ${cwd}, but conversation fork failed: ${String(error)}`);
    throw error;
  }

  return { hostId: currentHost(), sessionId, sessionPath, cwd, ...worktree };
}

async function copyRetainedDiffs(source: string, destination: string, ids: ReadonlySet<string>) {
  try {
    const diffs = JSON.parse(await readFile(source.replace(/\.jsonl$/, ".diffs.json"), "utf8"));
    const file = await open(destination.replace(/\.jsonl$/, ".diffs.json"), "wx", 0o600);

    try { await file.writeFile(JSON.stringify(Object.fromEntries(Object.entries(diffs).filter(([id]) => ids.has(id))))); }
    finally { await file.close(); }
  } catch (error) { if (!Check(fileErrorSchema, error) || error.code !== "ENOENT") throw error; }
}

async function cleanupForkDirectory(cwd: string, options: ForkOptions) {
  if (options.cwd !== undefined) await rmdir(cwd).catch(() => undefined);
}

async function forkDirectory(cwd: string, options: ForkOptions) {
  if (options.cwd !== undefined && options.worktree !== undefined) throw new Error("Choose cwd or worktree, not both");

  if (options.cwd === undefined) return realpath(cwd);
  const destination = resolve(cwd, options.cwd);
  const path = join(await realpath(dirname(destination)), basename(destination));

  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (Check(fileErrorSchema, error) && error.code === "EEXIST") throw new Error(`Fork destination already exists: ${path}`);
    throw error;
  }

  return path;
}

function responseBoundary(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, index: number) {
  const entry = branch[index];

  if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Select an assistant response to branch from");
  const pending = new Set(entry.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []));
  let end = index;

  while (pending.size && end + 1 < branch.length) {
    const next = branch[++end];

    if (next.type !== "message") continue;

    if (next.message.role !== "toolResult") break;
    pending.delete(next.message.toolCallId);
  }

  if (pending.size) throw new Error("The selected response still has unfinished tool calls. Wait for those tools to finish before branching.");

  return end;
}

function forkHistory(ctx: ExtensionContext, entryId?: string) {
  const branch = ctx.sessionManager.getBranch();
  const complete = (entry: typeof branch[number]) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "toolUse" && !entry.message.content.some((part) => part.type === "toolCall");
  const entry = entryId ? branch.find((entry) => entry.id === entryId) : [...branch].reverse().find(complete);

  if (entryId && !entry) throw new Error("The selected response is no longer on the current branch. Reload the conversation and select it again.");

  if (!entry) return [];
  const end = responseBoundary(branch, branch.indexOf(entry));
  const retained = branch.slice(0, end + 1);
  const ids = new Set(retained.map((item) => item.id));

  const checkpoint = branch.slice(end + 1).find((item) => item.type === "custom" && item.customType === "pi-project-files-watch-snapshot"
    && Check(responseIdsSchema, item.data) && item.data.responseEntryIds.includes(entry.id));

  if (checkpoint?.type === "custom" && Check(responseIdsSchema, checkpoint.data)) {
    const data = checkpoint.data;
    retained.push({ ...checkpoint, parentId: retained.at(-1)?.id ?? null, data: { ...data, responseEntryIds: data.responseEntryIds.filter((id) => ids.has(id)) } });
  }

  return retained;
}
