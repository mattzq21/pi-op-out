import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, realpath, mkdir, rmdir, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { currentHost } from "./client.ts";
import { writeSessionFile } from "./session-file.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export type ForkOptions = { cwd?: string; worktree?: string; entryId?: string };

export type CreatedWorktree = { path: string; branch: string; setupError?: string | null };

type PinnedPrompt = { cwd: string; ref: string; commit: string };

function forkPromptRepository(root: string | undefined, header: { cwd: string; checkpointRepositoryRoot?: string }) { return root ?? header.checkpointRepositoryRoot ?? header.cwd; }

function validForkPrompt(data: { key?: string; commit?: string } | undefined) {
  return /^[a-zA-Z0-9-]+$/.test(data?.key ?? "") && /^[a-f0-9]{40,64}$/.test(data?.commit ?? "");
}

async function pinForkPrompts(header: NonNullable<ReturnType<ExtensionContext["sessionManager"]["getHeader"]>>, retained: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, sessionId: string, pinned: PinnedPrompt[]) {
  const sourceId = header.id.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";

  for (const entry of retained) {
    if (entry.type !== "custom" || entry.customType !== "pi-project-prompt-checkpoint") continue;
    const data = entry.data as { key?: string; commit?: string; repositoryRoot?: string; unavailable?: boolean };

    if (data?.unavailable) continue;

    if (!validForkPrompt(data)) throw new Error("Invalid prompt checkpoint");
    const repository = forkPromptRepository(data.repositoryRoot, header);
    const source = `refs/pi-session-snapshots/chats/${sourceId}/prompts/${data.key}`;
    const ref = `refs/pi-session-snapshots/chats/${sessionId}/prompts/${data.key}`;
    const commit = data.commit!;
    const existing = await runFile("git", ["-C", repository, "rev-parse", "--verify", source], { timeout: 10000 });

    if (existing.stdout.trim() !== commit) throw new Error("Prompt checkpoint changed while forking");
    await runFile("git", ["-C", repository, "update-ref", ref, commit, "0".repeat(commit.length)], { timeout: 10000 });
    pinned.push({ cwd: repository, ref, commit });
    entry.data = { ...data, repositoryRoot: repository };
  }
}

function inheritGoal(ctx: ExtensionContext, retained: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, timestamp: string) {
  const goal = [...ctx.sessionManager.getEntries()].reverse().find(entry => entry.type === "custom" && entry.customType === "piop-goal");

  if (goal?.type === "custom") retained.push({ ...structuredClone(goal), id: randomUUID().slice(0, 8), parentId: retained.at(-1)?.id ?? null, timestamp });
}

export async function forkConversation(ctx: ExtensionContext, options: ForkOptions, createWorktree: (name: string) => Promise<CreatedWorktree>) {
  const retained = structuredClone(forkHistory(ctx, options.entryId));
  const header = ctx.sessionManager.getHeader();

  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before forking it");
  let cwd = await forkDirectory(ctx.cwd, options);
  const worktree = options.worktree ? await createWorktree(options.worktree) : undefined;

  if (worktree) cwd = worktree.path;
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  inheritGoal(ctx, retained, timestamp);
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  let created = false;
  const pinned: PinnedPrompt[] = [];

  try {
    await pinForkPrompts(header, retained, sessionId, pinned);
    await writeSessionFile(sessionPath, [{ ...header, id: sessionId, timestamp, cwd, parentSession: ctx.sessionManager.getSessionFile() }, ...retained]);
    created = true;

    try {
      const source = ctx.sessionManager.getSessionFile()!;
      const diffs = JSON.parse(await readFile(source.replace(/\.jsonl$/, ".diffs.json"), "utf8"));
      const ids = new Set(retained.map(entry => entry.id));
      const file = await open(sessionPath.replace(/\.jsonl$/, ".diffs.json"), "wx", 0o600);

      try { await file.writeFile(JSON.stringify(Object.fromEntries(Object.entries(diffs).filter(([id]) => ids.has(id))))); }
      finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) {
    if (created) {
      await rm(sessionPath, { force: true });
      await rm(sessionPath.replace(/\.jsonl$/, ".diffs.json"), { force: true });
    }

    await Promise.all(pinned.map(item => runFile("git", ["-C", item.cwd, "update-ref", "-d", item.ref, item.commit], { timeout: 10000 })));
    await cleanupForkDirectory(cwd, options);

    if (worktree) throw new Error(`Worktree kept at ${cwd}, but conversation fork failed: ${String(error)}`);
    throw error;
  }

  return { hostId: currentHost(), sessionId, sessionPath, cwd, ...worktree };
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Fork destination already exists: ${path}`);
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
    && (item.data as { responseEntryIds?: string[] })?.responseEntryIds?.includes(entry.id));

  if (checkpoint?.type === "custom") {
    const data = checkpoint.data as { responseEntryIds: string[] };
    retained.push({ ...checkpoint, parentId: retained.at(-1)!.id, data: { ...data, responseEntryIds: data.responseEntryIds.filter((id) => ids.has(id)) } });
  }

  return retained;
}
