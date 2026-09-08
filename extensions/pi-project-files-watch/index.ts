import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REF_ROOT = "refs/pi-session-snapshots";
const PROMPT_ENTRY = "pi-project-prompt-checkpoint";
const PROMPT_LIMIT = 10;
const SNAPSHOT_ENTRY = "pi-project-files-watch-snapshot";
const CHANGE_CONTEXT_MESSAGE = "pi-project-files-watch";
const MAX_LISTED_FILES = 200;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_CHANGED_PATHS = 4096;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null) { super(message); }
}

function runGit(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTooLarge = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT) { outputTooLarge = true; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", (code) => {
      if (outputTooLarge) { reject(new GitError("Git output exceeded 4 MiB", code)); return; }
      const out = Buffer.concat(stdout).toString("utf8");
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(out);
      else reject(new GitError(error || `git ${args[0]} exited with code ${code}`, code));
    });
    child.stdin.end(input);
  });
}

async function repositoryRoot(cwd: string) {
  try { return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim(); }
  catch (error) {
    if (error instanceof GitError && error.exitCode === 128) return undefined;
    throw error;
  }
}

function safeSessionId(sessionId: string) {
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";
  return safeId;
}

function sessionRefPrefix(sessionId: string) {
  return `${REF_ROOT}/chats/${safeSessionId(sessionId)}/`;
}

function legacySessionRef(sessionId: string) {
  return `${REF_ROOT}/${safeSessionId(sessionId)}`;
}

async function resolveRef(root: string, ref: string) {
  try { return (await runGit(root, ["rev-parse", "--verify", ref])).trim(); }
  catch (error) { if (error instanceof GitError && error.exitCode === 128) return undefined; throw error; }
}

async function sessionSnapshots(root: string, sessionId: string) {
  const output = await runGit(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%09%(objectname)", sessionRefPrefix(sessionId)]);
  return output.split("\n").flatMap((line) => {
    const [ref, commit] = line.split("\t");
    return ref && commit && !ref.includes("/prompts/") ? [{ ref, commit }] : [];
  });
}

async function currentSnapshot(root: string, sessionId: string) {
  const [snapshot] = await sessionSnapshots(root, sessionId);
  if (snapshot) return snapshot;
  const ref = legacySessionRef(sessionId);
  const commit = await resolveRef(root, ref);
  return commit ? { ref, commit } : undefined;
}

async function sessionIdFromFile(sessionFile: string) {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(sessionFile, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = contents.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) throw new Error("Parent session header is too large");
    const header = JSON.parse(newline < 0 ? contents : contents.slice(0, newline));
    return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } finally {
    await handle.close();
  }
}

function snapshotName(timestamp: string, commit: string) {
  return `${timestamp.replace(/[-:.]/g, "")}-${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
}

async function inheritParentSnapshot(root: string, sessionId: string, parentSessionFile: string) {
  const parentSessionId = await sessionIdFromFile(parentSessionFile);
  if (!parentSessionId || parentSessionId === sessionId) return undefined;
  const parent = await currentSnapshot(root, parentSessionId);
  if (!parent) return undefined;

  const timestamp = new Date().toISOString();
  const ref = `${sessionRefPrefix(sessionId)}${snapshotName(timestamp, parent.commit)}`;
  await runGit(root, ["update-ref", "--stdin"], {}, [
    "start",
    `create ${ref} ${parent.commit}`,
    "prepare",
    "commit",
    "",
  ].join("\n"));
  return {
    version: 1,
    repositoryRoot: root,
    ref,
    commit: parent.commit,
    capturedAt: timestamp,
    inheritedFromSession: parentSessionId,
  };
}

async function recoverCopiedSnapshot(ctx: ExtensionContext, root: string, sessionId: string) {
  const copied = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY);
  if (!copied || copied.type !== "custom" || !copied.data || typeof copied.data !== "object") return undefined;
  const data = copied.data as { repositoryRoot?: unknown; commit?: unknown };
  if (data.repositoryRoot !== root || typeof data.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(data.commit)) return undefined;
  try { await runGit(root, ["cat-file", "-e", `${data.commit}^{commit}`]); }
  catch { return undefined; }
  const timestamp = new Date().toISOString();
  const ref = `${sessionRefPrefix(sessionId)}${snapshotName(timestamp, data.commit)}`;
  await runGit(root, ["update-ref", ref, data.commit]);
  return { version: 1, repositoryRoot: root, ref, commit: data.commit, capturedAt: timestamp };
}

async function assertSnapshotInputBounded(root: string) {
  const base = await resolveRef(root, "HEAD");
  const tracked = await runGit(root, base ? ["diff", "--name-only", "--no-renames", "-z", base, "--"] : ["ls-files", "--cached", "-z", "--"]);
  const untracked = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  const paths = [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
  if (paths.length > MAX_CHANGED_PATHS) throw new Error(`Git snapshot has more than ${MAX_CHANGED_PATHS} changed files`);
  let total = 0;
  for (const path of paths) {
    let metadata;
    try { metadata = await lstat(join(root, path)); } catch { continue; }
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`Git snapshot file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB: ${path}`);
    total += metadata.size;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error(`Git snapshot exceeds ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB`);
  }
}

async function worktreeTree(root: string, isolated = false) {
  await assertSnapshotInputBounded(root);
  const temporary = await mkdtemp(join(tmpdir(), "pi-git-snapshot-"));
  const index = join(temporary, "index");
  const env: Record<string, string> = { GIT_INDEX_FILE: index };
  try {
    if (isolated) {
      const configuredObjects = (await runGit(root, ["rev-parse", "--git-path", "objects"])).trim();
      const repositoryObjects = await realpath(configuredObjects.startsWith("/") ? configuredObjects : join(root, configuredObjects));
      const objects = join(temporary, "objects"); await mkdir(objects);
      env.GIT_OBJECT_DIRECTORY = objects;
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = repositoryObjects;
    }
    const seed = (await runGit(root, ["write-tree"])).trim();
    await runGit(root, ["read-tree", seed], env);
    await runGit(root, ["add", "--all", "--", "."], env);
    const tree = (await runGit(root, ["write-tree"], env)).trim();
    return { tree, env, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function saveSnapshot(root: string, sessionId: string) {
  const previous = await sessionSnapshots(root, sessionId);
  const legacyRef = legacySessionRef(sessionId);
  const legacyCommit = await resolveRef(root, legacyRef);
  const captured = await worktreeTree(root);
  const timestamp = new Date().toISOString();
  const identity = {
    GIT_AUTHOR_NAME: "Pi session snapshot",
    GIT_AUTHOR_EMAIL: "pi-session-snapshot@localhost",
    GIT_COMMITTER_NAME: "Pi session snapshot",
    GIT_COMMITTER_EMAIL: "pi-session-snapshot@localhost",
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
  let commit: string;
  try { commit = (await runGit(root, ["commit-tree", captured.tree], identity, `Pi session snapshot ${sessionId} ${timestamp}\n`)).trim(); }
  finally { await captured.cleanup(); }
  const ref = `${sessionRefPrefix(sessionId)}${snapshotName(timestamp, commit)}`;
  const deletes = [...previous, ...(legacyCommit ? [{ ref: legacyRef, commit: legacyCommit }] : [])];
  const transaction = [
    "start",
    `create ${ref} ${commit}`,
    ...deletes.map((snapshot) => `delete ${snapshot.ref} ${snapshot.commit}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  await runGit(root, ["update-ref", "--stdin"], {}, transaction);
  return { version: 1, repositoryRoot: root, ref, commit, capturedAt: timestamp };
}

interface PromptCheckpoint {
  key: string;
  owner: string;
  commit: string;
  base: string | null;
  capturedAt: string;
}

function promptRef(sessionId: string, key: string) {
  return `${sessionRefPrefix(sessionId)}prompts/${key}`;
}

function checkpointData(data: unknown): PromptCheckpoint | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as PromptCheckpoint;
  return typeof value.key === "string" && /^[a-zA-Z0-9-]+$/.test(value.key)
    && typeof value.owner === "string" && typeof value.commit === "string" && /^[a-f0-9]{40,64}$/.test(value.commit)
    && (value.base === null || (typeof value.base === "string" && /^[a-f0-9]{40,64}$/.test(value.base)))
    ? value : undefined;
}

async function promptRefs(root: string, sessionId: string) {
  const output = await runGit(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%09%(objectname)", `${sessionRefPrefix(sessionId)}prompts/`]);
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [ref, commit] = line.split("\t"); return { ref, commit };
  });
}

async function capturePrompt(root: string, ctx: ExtensionContext): Promise<PromptCheckpoint> {
  const sessionId = ctx.sessionManager.getSessionId();
  // Expire by prompt order, even if the host's wall clock moves backwards.
  const order = new Map(ctx.sessionManager.getEntries().flatMap((entry, index) => {
    const data = entry.type === "custom" && entry.customType === PROMPT_ENTRY ? checkpointData(entry.data) : undefined;
    return data ? [[promptRef(sessionId, data.key), index] as const] : [];
  }));
  const previous = (await promptRefs(root, sessionId)).sort((a, b) => (order.get(b.ref) ?? -1) - (order.get(a.ref) ?? -1));
  const base = await resolveRef(root, "HEAD") ?? null;
  const captured = await worktreeTree(root);
  const capturedAt = new Date().toISOString();
  let commit: string;
  try {
    commit = (await runGit(root, ["commit-tree", captured.tree, ...(base ? ["-p", base] : [])], {
      GIT_AUTHOR_NAME: "Pi prompt checkpoint", GIT_AUTHOR_EMAIL: "pi-checkpoint@localhost",
      GIT_COMMITTER_NAME: "Pi prompt checkpoint", GIT_COMMITTER_EMAIL: "pi-checkpoint@localhost",
    }, `Pi before prompt ${sessionId} ${capturedAt}\n`)).trim();
  } finally { await captured.cleanup(); }
  const key = `${capturedAt.replace(/[-:.]/g, "")}-${randomUUID()}`;
  await runGit(root, ["update-ref", "--stdin"], {}, [
    "start", `create ${promptRef(sessionId, key)} ${commit}`,
    ...previous.slice(PROMPT_LIMIT - 1).map(({ ref, commit }) => `delete ${ref} ${commit}`),
    "prepare", "commit", "",
  ].join("\n"));
  return { key, owner: sessionId, commit, base, capturedAt };
}

// A child owns its own refs, so deleting or advancing its parent cannot expire them.
async function pinPromptHistory(root: string, sessionId: string, entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, sourceOwner?: string) {
  const checkpoints = entries.flatMap((entry) => entry.type === "custom" && entry.customType === PROMPT_ENTRY
    ? [checkpointData(entry.data)].filter((value): value is PromptCheckpoint => Boolean(value)) : []).slice(-PROMPT_LIMIT);
  for (const checkpoint of checkpoints) {
    const target = promptRef(sessionId, checkpoint.key);
    if (await resolveRef(root, target)) continue;
    const source = promptRef(sourceOwner ?? checkpoint.owner, checkpoint.key);
    if (await resolveRef(root, source) !== checkpoint.commit) continue;
    await runGit(root, ["update-ref", "--stdin"], {}, ["start", `verify ${source} ${checkpoint.commit}`, `create ${target} ${checkpoint.commit}`, "prepare", "commit", ""].join("\n"));
  }
}

async function branchBeforePrompt(ctx: ExtensionContext, entryId: string, name: string) {
  const root = await repositoryRoot(ctx.cwd);
  if (!root) throw new Error("Project is not a Git repository");
  const history = ctx.sessionManager.getBranch(entryId);
  const user = history.at(-1);
  if (!user || user.id !== entryId || user.type !== "message" || user.message.role !== "user") throw new Error("Prompt not found in this conversation");
  // Stop at the previous user; a failed/missing capture must never borrow its checkpoint.
  let checkpoint: PromptCheckpoint | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    const entry = history[i];
    if (entry.type === "message" && entry.message.role === "user") break;
    if (entry.type === "custom" && entry.customType === PROMPT_ENTRY) { checkpoint = checkpointData(entry.data); break; }
  }
  const owner = ctx.sessionManager.getSessionId();
  if (!checkpoint || await resolveRef(root, promptRef(owner, checkpoint.key)) !== checkpoint.commit) {
    throw new Error("Project snapshot unavailable. Only the latest 10 prompt checkpoints are retained; older prompts cannot restore historical files.");
  }
  name = name.trim();
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Name may only contain letters, numbers, dots, hyphens, and underscores");
  const project = basename(root).replace(/[^a-zA-Z0-9_]+/g, "-").replace(/^-|-$/g, "") || "project";
  const branch = `${project}-${name}`;
  await runGit(root, ["check-ref-format", "--branch", branch]);
  const target = join(dirname(root), branch);
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const existingBranch = await runGit(root, ["show-ref", "--verify", `refs/heads/${branch}`]).catch(() => "");
  if (existingBranch) throw new Error("Branch already exists");
  const before = await runGit(root, ["worktree", "list", "--porcelain"]);
  if (before.split("\n").includes(`worktree ${target}`)) throw new Error("Worktree already exists");
  try { await lstat(target); throw new Error("Worktree directory already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let created = false;
  let sessionWritten = false;
  try {
    created = true;
    await runGit(root, ["worktree", "add", ...(checkpoint.base ? [] : ["--orphan"]), "-b", branch, target, ...(checkpoint.base ? [checkpoint.base] : [])]);
    // Restore into the new worktree, then reset its index so captured changes stay uncommitted.
    await runGit(target, ["read-tree", "--reset", "-u", checkpoint.commit]);
    await runGit(target, ["read-tree", ...(checkpoint.base ? [checkpoint.base] : ["--empty"])]);
    const retained = history.slice(0, -1);
    await pinPromptHistory(root, id, retained, owner);
    const baselineRef = `${sessionRefPrefix(id)}${snapshotName(timestamp, checkpoint.commit)}`;
    await runGit(root, ["update-ref", baselineRef, checkpoint.commit]);
    const baseline = { type: "custom", id: randomUUID(), parentId: retained.at(-1)?.id ?? null, timestamp, customType: SNAPSHOT_ENTRY,
      data: { version: 1, repositoryRoot: target, ref: baselineRef, commit: checkpoint.commit, capturedAt: timestamp } };
    const header = { ...ctx.sessionManager.getHeader(), type: "session", id, timestamp, cwd: target, parentSession: ctx.sessionManager.getSessionFile() };
    const session = await open(sessionPath, "wx", 0o600);
    sessionWritten = true;
    try { await session.writeFile([header, ...retained, baseline].map((entry) => JSON.stringify(entry)).join("\n") + "\n"); }
    finally { await session.close(); }
    return { branch, path: target, sessionPath, sessionId: id };
  } catch (error) {
    if (sessionWritten) await rm(sessionPath, { force: true });
    for (const { ref, commit } of [...await promptRefs(root, id), ...await sessionSnapshots(root, id)]) await runGit(root, ["update-ref", "-d", ref, commit]);
    if (created) {
      await runGit(root, ["worktree", "remove", "--force", target]).catch(() => undefined);
      if (checkpoint.base) await runGit(root, ["branch", "-D", branch]).catch(() => undefined);
    }
    throw error;
  }
}

function shellQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }

function projectContext(root: string, baseline: string, current: string, files: string[], env: Record<string, string>) {
  const shown = files.slice(0, MAX_LISTED_FILES);
  const omitted = files.length - shown.length;
  const paths = shown.map((path) => `- ${JSON.stringify(path)}`).join("\n");
  const environment = ["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].flatMap((name) => env[name] ? [`${name}=${shellQuote(env[name])}`] : []).join(" ");
  const command = `${environment ? `${environment} ` : ""}git -C ${shellQuote(root)} diff --find-renames ${baseline} ${current} --`;
  return `<project_context>
Changed files since last message:
${paths}${omitted ? `\n- … ${omitted} more changed file${omitted === 1 ? "" : "s"}` : ""}

If full diff is relevant, run:
${command}
</project_context>`;
}

export default function projectFilesWatch(pi: ExtensionAPI) {
  let snapshotQueue = Promise.resolve();
  let pendingContext: string | undefined;
  let pendingSnapshotCleanup: (() => Promise<void>) | undefined;
  let lastError = "";

  const reportError = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) { lastError = message; ctx.ui.notify(`Git session snapshot failed: ${message}`, "warning"); }
  };

  const inheritSnapshot = async (ctx: ExtensionContext, parentSessionFile?: string) => {
    const root = await repositoryRoot(ctx.cwd);
    if (!root) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const current = await currentSnapshot(root, sessionId);
    if (current) return current;
    const copied = await recoverCopiedSnapshot(ctx, root, sessionId);
    if (copied) { pi.appendEntry(SNAPSHOT_ENTRY, copied); return copied; }
    if (!parentSessionFile) return undefined;
    const inherited = await inheritParentSnapshot(root, sessionId, parentSessionFile);
    if (inherited) pi.appendEntry(SNAPSHOT_ENTRY, inherited);
    return inherited;
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "fork") return;
    snapshotQueue = snapshotQueue.then(async () => {
      await inheritSnapshot(ctx, ctx.sessionManager.getHeader()?.parentSession ?? event.previousSessionFile);
      const root = await repositoryRoot(ctx.cwd);
      const parentFile = ctx.sessionManager.getHeader()?.parentSession ?? event.previousSessionFile;
      if (root) await pinPromptHistory(root, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), parentFile ? await sessionIdFromFile(parentFile) : undefined);
      lastError = "";
    }).catch((error) => reportError(ctx, error));
    return snapshotQueue;
  });

  // Pi awaits message_start handlers before proceeding. This also covers consumed
  // follow-ups and steering messages; queue submission itself is not a checkpoint.
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const text = typeof event.message.content === "string" ? event.message.content
      : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const resume = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-desktop-resume" && (entry.data as { message?: string })?.message === text);
    if (resume) return;
    snapshotQueue = snapshotQueue.then(async () => {
      try {
        const root = await repositoryRoot(ctx.cwd);
        if (!root) { pi.appendEntry(PROMPT_ENTRY, { unavailable: true }); return; }
        pi.appendEntry(PROMPT_ENTRY, await capturePrompt(root, ctx));
      } catch (error) {
        pi.appendEntry(PROMPT_ENTRY, { unavailable: true });
        reportError(ctx, error);
      }
    });
    return snapshotQueue;
  });

  pi.registerCommand("pi-desktop-branch-checkpoint", {
    description: "Create a worktree and conversation before a retained prompt",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args); id = request.id;
        if (ctx.mode !== "rpc" || typeof id !== "string" || typeof request.entryId !== "string" || typeof request.name !== "string") throw new Error("Invalid checkpoint branch request");
        const operation = snapshotQueue.then(() => branchBeforePrompt(ctx, request.entryId, request.name));
        snapshotQueue = operation.then(() => undefined, () => undefined);
        const data = await operation;
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: "branch_checkpoint", success: true, data })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: "branch_checkpoint", success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else reportError(ctx, error);
      }
    },
  });

  pi.on("session_shutdown", async () => { await snapshotQueue; await pendingSnapshotCleanup?.(); pendingSnapshotCleanup = undefined; });

  pi.on("message_end", (event, ctx) => {
    snapshotQueue = snapshotQueue.then(async () => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
      const root = await repositoryRoot(ctx.cwd);
      if (!root) return;
      const snapshot = await saveSnapshot(root, ctx.sessionManager.getSessionId());
      pi.appendEntry(SNAPSHOT_ENTRY, snapshot);
      lastError = "";
    }).catch((error) => reportError(ctx, error));
    return snapshotQueue;
  });

  pi.on("input", async (event, ctx) => {
    pendingContext = undefined;
    if (pendingSnapshotCleanup && ctx.isIdle()) { await pendingSnapshotCleanup(); pendingSnapshotCleanup = undefined; }
    if (event.source === "extension" || !event.text.trim()) {
      return { action: "continue" };
    }
    await snapshotQueue;
    try {
      const root = await repositoryRoot(ctx.cwd);
      if (!root) return { action: "continue" };
      const sessionId = ctx.sessionManager.getSessionId();
      let snapshot = await currentSnapshot(root, sessionId);
      if (!snapshot) snapshot = await inheritSnapshot(ctx, ctx.sessionManager.getHeader()?.parentSession);
      if (!snapshot) return { action: "continue" };
      const current = await worktreeTree(root, true);
      let rawPaths: string;
      try { rawPaths = await runGit(root, ["diff", "--name-only", "-z", "--find-renames", snapshot.commit, current.tree, "--"], current.env); }
      catch (error) { await current.cleanup(); throw error; }
      const files = rawPaths.split("\0").filter(Boolean);
      if (!files.length) { await current.cleanup(); return { action: "continue" }; }
      lastError = "";
      const previousCleanup = pendingSnapshotCleanup;
      pendingSnapshotCleanup = async () => { await previousCleanup?.(); await current.cleanup(); };
      pendingContext = projectContext(root, snapshot.commit, current.tree, files, current.env);
      return { action: "continue" };
    } catch (error) {
      reportError(ctx, error);
      return { action: "continue" };
    }
  });

  pi.on("before_agent_start", () => {
    const content = pendingContext;
    pendingContext = undefined;
    if (!content) return;
    return { message: { customType: CHANGE_CONTEXT_MESSAGE, content, display: false } };
  });

  pi.on("context", (event) => {
    let contextIndex = -1;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message.role === "custom" && message.customType === CHANGE_CONTEXT_MESSAGE) { contextIndex = index; break; }
    }
    if (contextIndex < 0) return;
    let userIndex = -1;
    for (let index = contextIndex - 1; index >= 0; index -= 1) {
      if (event.messages[index].role === "user") { userIndex = index; break; }
    }
    if (userIndex < 0 || contextIndex !== userIndex + 1) return;
    const messages = [...event.messages];
    const [context] = messages.splice(contextIndex, 1);
    messages.splice(userIndex, 0, context);
    return { messages };
  });
}
