import { GitError, runGit } from "./git.ts";
import { lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REF_ROOT = "refs/pi-session-snapshots";

const PROMPT_ENTRY = "pi-project-prompt-checkpoint";

const SNAPSHOT_ENTRY = "pi-project-files-watch-snapshot";

const CHANGE_CONTEXT_MESSAGE = "pi-project-files-watch";

const MAX_LISTED_FILES = 200;

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

const MAX_CHANGED_PATHS = 4096;

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

const MAX_FILE_BYTES = 16 * 1024 * 1024;

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

async function assertSnapshotCommitSafe(root: string) {
  const gitDirectory = (await runGit(root, ["rev-parse", "--absolute-git-dir"])).trim();

  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"]) {
    try { await lstat(join(gitDirectory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }

    throw new Error("Finish or abort the in-progress Git operation before saving an agent-settled commit");
  }

  if (await runGit(root, ["ls-files", "--unmerged", "-z"])) {
    throw new Error("Resolve Git conflicts before saving an agent-settled commit");
  }
}

async function saveSnapshot(root: string, sessionId: string) {
  const branch = (await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch((error) => {
    if (error instanceof GitError && error.exitCode === 1) throw new Error("Check out a branch before saving an agent-settled commit");
    throw error;
  })).trim();

  await assertSnapshotInputBounded(root);
  const timestamp = new Date().toISOString();

  const identity = {
    GIT_AUTHOR_NAME: "Pi session snapshot",
    GIT_AUTHOR_EMAIL: "pi-session-snapshot@localhost",
    GIT_COMMITTER_NAME: "Pi session snapshot",
    GIT_COMMITTER_EMAIL: "pi-session-snapshot@localhost",
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };

  await assertSnapshotCommitSafe(root);
  await runGit(root, ["add", "--all", "--", "."]);
  await runGit(root, ["commit", "--allow-empty", "-m", `Pi agent settled ${sessionId} ${timestamp}`], identity);
  const commit = await resolveRef(root, "HEAD");

  if (!commit) throw new Error("Could not resolve the agent-settled commit");
  const ref = `${sessionRefPrefix(sessionId)}${snapshotName(timestamp, commit)}`;

  const transaction = [
    "start",
    `create ${ref} ${commit}`,
    "prepare",
    "commit",
    "",
  ].join("\n");

  await runGit(root, ["update-ref", "--stdin"], {}, transaction);

  return { version: 1, repositoryRoot: root, ref, commit, branch, capturedAt: timestamp };
}

interface PromptCheckpoint {
  repositoryRoot?: string;
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
    && validCheckpointBase(value.base)
    ? value : undefined;
}

function validCheckpointBase(base: unknown) { return base === null || (typeof base === "string" && /^[a-f0-9]{40,64}$/.test(base)); }

async function promptRefs(root: string, sessionId: string) {
  const output = await runGit(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%09%(objectname)", `${sessionRefPrefix(sessionId)}prompts/`]);

  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [ref, commit] = line.split("\t");

    return { ref, commit };
  });
}

async function capturePrompt(root: string, ctx: ExtensionContext): Promise<PromptCheckpoint> {
  const sessionId = ctx.sessionManager.getSessionId();
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
    "prepare", "commit", "",
  ].join("\n"));

  return { key, owner: sessionId, commit, base, capturedAt, repositoryRoot: root };
}

async function pinPromptHistory(root: string | undefined, sessionId: string, entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, sourceOwner?: string) {
  const checkpoints = entries.flatMap((entry) => entry.type === "custom" && entry.customType === PROMPT_ENTRY
    ? [checkpointData(entry.data)].filter((value): value is PromptCheckpoint => Boolean(value)) : []);

  for (const checkpoint of checkpoints) {
    const target = promptRef(sessionId, checkpoint.key);
    const source = promptRef(sourceOwner ?? checkpoint.owner, checkpoint.key);
    const repositories = new Set([root, checkpoint.repositoryRoot].filter((repository): repository is string => Boolean(repository)));

    for (const repository of repositories) {
      if (await resolveRef(repository, target) === checkpoint.commit) break;

      if (await resolveRef(repository, source) !== checkpoint.commit) continue;
      await runGit(repository, ["update-ref", "--stdin"], {}, ["start", `verify ${source} ${checkpoint.commit}`, `create ${target} ${checkpoint.commit}`, "prepare", "commit", ""].join("\n"));
      break;
    }
  }
}

async function checkpointWorktreeTarget(root: string, branch: string) {
  const parentBranch = await runGit(root, ["symbolic-ref", "--quiet", "HEAD"]).then((value) => value.trim()).catch(() => null);
  const listed = await runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  const worktrees = listed.split("\0").filter((entry) => entry.startsWith("worktree ")).map((entry) => entry.slice(9));

  if (!worktrees.length) throw new Error("Could not locate the main checkout");
  const project = basename(worktrees[0]);

  if (!project) throw new Error("Git repository directory has no name");
  const storage = join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "worktrees");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const container = join(storage, randomUUID().slice(0, 4));
  const target = join(container, project);

  if (worktrees.includes(target)) throw new Error(`Git worktree is already registered: ${target}`);

  try { await mkdir(container, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Worktree directory already exists: ${container}`); throw error; }

  try { await writeFile(join(container, "parent.json"), JSON.stringify({ branch, parentBranch }), { flag: "wx", mode: 0o600 }); }
  catch (error) { await rmdir(container).catch(() => undefined); throw error; }

  return target;
}

async function branchCheckpoint(ctx: ExtensionContext, entryId: string, name: string, afterResponse = false) {
  const root = await repositoryRoot(ctx.cwd);

  if (!root) throw new Error("Project is not a Git repository");
  const history = ctx.sessionManager.getBranch(entryId);
  validateBranchMessage(history, entryId, afterResponse);
  let checkpoint = precedingCheckpoint(history, afterResponse);
  const owner = ctx.sessionManager.getSessionId();

  if (afterResponse) checkpoint = await responseCheckpoint(ctx, root, entryId, owner);

  if (!checkpoint || !await checkpointRefValid(root, owner, checkpoint, afterResponse)) {
    throw new Error("Project snapshot unavailable. This prompt's checkpoint is missing or was removed.");
  }

  const branch = await checkpointBranchName(root, name);
  const target = await checkpointWorktreeTarget(root, branch);
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  let created = false;
  let sessionWritten = false;

  try {
    await assertWorktreeAvailable(root, branch, target);
    await runGit(root, ["worktree", "add", "-b", branch, target, checkpoint.commit]);
    created = true;
    const entries = await branchSessionEntries(ctx, root, id, history, owner, checkpoint, timestamp, target, afterResponse, entryId);
    const session = await open(sessionPath, "wx", 0o600);
    sessionWritten = true;

    try { await session.writeFile(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); }
    finally { await session.close(); }

    return { branch, path: target, sessionPath, sessionId: id };
  } catch (error) {
    if (sessionWritten) await rm(sessionPath, { force: true });

    for (const { ref, commit } of [...await promptRefs(root, id), ...await sessionSnapshots(root, id)]) await runGit(root, ["update-ref", "-d", ref, commit]);

    if (created) {
      await runGit(root, ["worktree", "remove", "--force", target])
        .then(() => runGit(root, ["branch", "-D", branch])).catch(() => undefined);
    }

    throw error;
  } finally { await cleanupCheckpointContainer(target); }
}

async function cleanupCheckpointContainer(target: string) {
  try { await lstat(target);

  return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }

  await rm(join(dirname(target), "parent.json"), { force: true });
  await rmdir(dirname(target)).catch(() => undefined);
}

async function checkpointRefValid(root: string, owner: string, checkpoint: PromptCheckpoint, afterResponse: boolean) {
  return afterResponse || await resolveRef(root, promptRef(owner, checkpoint.key)) === checkpoint.commit;
}

type CheckpointHistory = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

function validateBranchMessage(history: CheckpointHistory, entryId: string, afterResponse: boolean) {
  const user = history.at(-1);

  if (!user || user.id !== entryId || user.type !== "message" || user.message.role !== (afterResponse ? "assistant" : "user")) throw new Error("Message not found in this conversation");

}

function precedingCheckpoint(history: CheckpointHistory, afterResponse: boolean) {
  let checkpoint: PromptCheckpoint | undefined;

  for (let i = history.length - 2; !afterResponse && i >= 0; i--) {
    const entry = history[i];

    if (entry.type === "message" && entry.message.role === "user") break;

    if (entry.type === "custom" && entry.customType === PROMPT_ENTRY) { checkpoint = checkpointData(entry.data); break; }
  }

  return checkpoint;
}

async function responseCheckpoint(ctx: ExtensionContext, root: string, entryId: string, owner: string) {
  const saved = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY
    && (entry.data as { responseEntryIds?: string[] })?.responseEntryIds?.includes(entryId));

  const data = saved?.type === "custom" ? saved.data as { commit?: string } : undefined;

  if (!data?.commit || !/^[a-f0-9]{40,64}$/.test(data.commit)) {
    throw new Error("No settled Git checkpoint is available for this response. Wait for the agent to settle or stop it first.");
  }

  await runGit(root, ["cat-file", "-e", `${data.commit}^{commit}`]);

  return { key: "", owner, commit: data.commit, base: data.commit, capturedAt: "" };
}

async function checkpointBranchName(root: string, name: string) {
  name = name.trim();

  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Name may only contain letters, numbers, dots, hyphens, and underscores");
  const reference = await runGit(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => { throw new Error("Switch to a branch before creating a child worktree"); });
  const parent = reference.trim().replace(/^refs\/heads\//, "");
  const branch = `${parent}|${name}`;
  await runGit(root, ["check-ref-format", "--branch", branch]);

  return branch;
}

async function assertWorktreeAvailable(root: string, branch: string, target: string) {
  const existingBranch = await runGit(root, ["show-ref", "--verify", `refs/heads/${branch}`]).catch(() => "");

  if (existingBranch) throw new Error("Branch already exists");
  const before = await runGit(root, ["worktree", "list", "--porcelain"]);

  if (before.split("\n").includes(`worktree ${target}`)) throw new Error("Worktree already exists");

  try { await lstat(target); throw new Error("Worktree directory already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

}

async function branchSessionEntries(ctx: ExtensionContext, root: string, id: string, history: CheckpointHistory, owner: string, checkpoint: PromptCheckpoint, timestamp: string, target: string, afterResponse: boolean, entryId: string) {
  const retained = afterResponse ? history : history.slice(0, -1);
  await pinPromptHistory(root, id, retained, owner);
  const baselineRef = `${sessionRefPrefix(id)}${snapshotName(timestamp, checkpoint.commit)}`;
  await runGit(root, ["update-ref", baselineRef, checkpoint.commit]);

  const baseline = {
    type: "custom", id: randomUUID(), parentId: retained.at(-1)?.id ?? null, timestamp, customType: SNAPSHOT_ENTRY,
    data: { version: 1, repositoryRoot: target, ref: baselineRef, commit: checkpoint.commit, capturedAt: timestamp, ...(afterResponse ? { responseEntryIds: [entryId] } : {}) }
  };

  const header = { ...ctx.sessionManager.getHeader(), type: "session", id, timestamp, cwd: target, parentSession: ctx.sessionManager.getSessionFile() };

  return [header, ...retained, baseline];
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

export default function diffWatch(pi: ExtensionAPI) {
  let snapshotQueue = Promise.resolve();
  let pendingContext: string | undefined;
  const queuedContexts = new Map<string, string[]>();
  const queuedContextEntry = "piop-queued-project-context";
  pi.on("agent_settled", () => { queuedContexts.clear(); });
  let pendingSnapshotCleanup: (() => Promise<void>) | undefined;
  let lastError = "";
  let runStart: { sessionId: string; entryIds: Set<string> } | undefined;

  const reportError = (ctx: ExtensionContext, cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);

    if (message !== lastError) { lastError = message; ctx.ui.notify(`Git session snapshot failed: ${message}`, "warning"); }
  };

  const inheritSnapshot = async (ctx: ExtensionContext, parentSessionFile?: string) => {
    const root = await repositoryRoot(ctx.cwd);

    if (!root) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const current = await currentSnapshot(root, sessionId);

    if (current) return current;
    const copied = await recoverCopiedSnapshot(ctx, root, sessionId);

    if (copied) { pi.appendEntry(SNAPSHOT_ENTRY, copied);

    return copied; }

    if (!parentSessionFile) return undefined;
    const inherited = await inheritParentSnapshot(root, sessionId, parentSessionFile);

    if (inherited) pi.appendEntry(SNAPSHOT_ENTRY, inherited);

    return inherited;
  };

  pi.on("session_start", (event, ctx) => {
    runStart = undefined;

    if (event.reason !== "fork" && !ctx.sessionManager.getHeader()?.parentSession) return;
    snapshotQueue = snapshotQueue.then(async () => {
      await inheritSnapshot(ctx, ctx.sessionManager.getHeader()?.parentSession ?? event.previousSessionFile);
      const root = await repositoryRoot(ctx.cwd);
      const parentFile = ctx.sessionManager.getHeader()?.parentSession ?? event.previousSessionFile;
      await pinPromptHistory(root, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), parentFile ? await sessionIdFromFile(parentFile) : undefined);
      lastError = "";
    }).catch((error) => reportError(ctx, error));

    return snapshotQueue;
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;

    const text = typeof event.message.content === "string" ? event.message.content
      : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

    const contexts = queuedContexts.get(text); const queuedContent = contexts?.shift();

    if (!contexts?.length) queuedContexts.delete(text);

    if (queuedContent) pi.appendEntry(queuedContextEntry, { timestamp: event.message.timestamp, content: queuedContent });
    const resume = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-desktop-resume" && (entry.data as { message?: string })?.message === text);

    if (resume) return;
    snapshotQueue = snapshotQueue.then(async () => {
      try {
        const root = await repositoryRoot(ctx.cwd);

        if (!root) { pi.appendEntry(PROMPT_ENTRY, { unavailable: true });

        return; }

        pi.appendEntry(PROMPT_ENTRY, await capturePrompt(root, ctx));
      } catch (error) {
        pi.appendEntry(PROMPT_ENTRY, { unavailable: true });
        reportError(ctx, error);
      }
    });

    return snapshotQueue;
  });

  pi.registerCommand("pi-desktop-branch-checkpoint", {
    description: "Create a worktree and conversation from a retained checkpoint",
    async handler(args, ctx) {
      let id: string | undefined;

      try {
        const request = JSON.parse(args); id = request.id;

        if (ctx.mode !== "rpc" || typeof id !== "string" || typeof request.entryId !== "string" || typeof request.name !== "string") throw new Error("Invalid checkpoint branch request");
        const operation = snapshotQueue.then(() => branchCheckpoint(ctx, request.entryId, request.name, request.afterResponse === true));
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

  pi.on("agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    if (runStart?.sessionId !== sessionId) runStart = { sessionId, entryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)) };
  });

  pi.on("agent_settled", (_event, ctx) => {
    const started = runStart;
    runStart = undefined;
    snapshotQueue = snapshotQueue.then(async () => {
      const history = ctx.sessionManager.getBranch();

      const responseEntryIds = started?.sessionId === ctx.sessionManager.getSessionId()
        ? history.flatMap((entry) => !started.entryIds.has(entry.id) && entry.type === "message" && entry.message.role === "assistant" ? [entry.id] : []).slice(-1) : [];

      const root = await repositoryRoot(ctx.cwd);

      if (!root) return;

      try {
        const snapshot = await saveSnapshot(root, ctx.sessionManager.getSessionId());
        pi.appendEntry(SNAPSHOT_ENTRY, { ...snapshot, responseEntryIds });
      } catch (error) {
        pi.appendEntry(SNAPSHOT_ENTRY, { unavailable: true, responseEntryIds });
        throw error;
      }

      lastError = "";
    }).catch((error) => reportError(ctx, error));

    return snapshotQueue;
  });

  const clearIdleSnapshot = async (ctx: ExtensionContext) => { if (pendingSnapshotCleanup && ctx.isIdle()) { await pendingSnapshotCleanup(); pendingSnapshotCleanup = undefined; } };

  const inputSnapshot = async (ctx: ExtensionContext, root: string) => {
    const snapshot = await currentSnapshot(root, ctx.sessionManager.getSessionId());

    return snapshot ?? await inheritSnapshot(ctx, ctx.sessionManager.getHeader()?.parentSession);
  };

  pi.on("input", async (event, ctx) => {
    pendingContext = undefined;
    await clearIdleSnapshot(ctx);

    if (event.source === "extension" || !event.text.trim()) {
      return { action: "continue" };
    }

    await snapshotQueue;

    try {
      const root = await repositoryRoot(ctx.cwd);

      if (!root) return { action: "continue" };
      const snapshot = await inputSnapshot(ctx, root);

      if (!snapshot) return { action: "continue" };
      const current = await worktreeTree(root, true);
      let rawPaths: string;

      try { rawPaths = await runGit(root, ["diff", "--name-only", "-z", "--find-renames", snapshot.commit, current.tree, "--"], current.env); }
      catch (error) { await current.cleanup(); throw error; }

      const files = rawPaths.split("\0").filter(Boolean);

      if (!files.length) { await current.cleanup();

      return { action: "continue" }; }

      lastError = "";
      const previousCleanup = pendingSnapshotCleanup;
      pendingSnapshotCleanup = async () => { await previousCleanup?.(); await current.cleanup(); };

      pendingContext = projectContext(root, snapshot.commit, current.tree, files, current.env);

      if (!ctx.isIdle()) {
        const contexts = queuedContexts.get(event.text) ?? [];
        contexts.push(pendingContext); queuedContexts.set(event.text, contexts);
        pendingContext = undefined;
      }

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

  pi.on("context", (event, ctx) => {
    const contexts = new Map(ctx.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== queuedContextEntry) return [];
      const data = entry.data as { timestamp?: number; content?: string };

      return typeof data?.timestamp === "number" && typeof data.content === "string" ? [[data.timestamp, data.content] as const] : [];
    }));

    const sourceMessages: typeof event.messages = event.messages.flatMap((message) => {
      const content = message.role === "user" ? contexts.get(message.timestamp) : undefined;

      return content ? [{ role: "custom" as const, customType: CHANGE_CONTEXT_MESSAGE, content, display: false, timestamp: message.timestamp }, message] : [message];
    });

    let contextIndex = -1;

    for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
      const message = sourceMessages[index];

      if (message.role === "custom" && message.customType === CHANGE_CONTEXT_MESSAGE) { contextIndex = index; break; }
    }

    if (contextIndex < 0) return { messages: sourceMessages };
    let userIndex = -1;

    for (let index = contextIndex - 1; index >= 0; index -= 1) {
      if (sourceMessages[index].role === "user") { userIndex = index; break; }
    }

    const adjacentUser = () => sourceMessages[contextIndex + 1]?.role === "user";

    if (userIndex < 0 || contextIndex !== userIndex + 1 || adjacentUser()) return { messages: sourceMessages };
    const messages = [...sourceMessages];
    const [context] = messages.splice(contextIndex, 1);
    messages.splice(userIndex, 0, context);

    return { messages };
  });
}
