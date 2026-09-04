import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REF_ROOT = "refs/pi-session-snapshots";
const SNAPSHOT_ENTRY = "pi-git-change-snapshot";
const CHANGE_CONTEXT_MESSAGE = "pi-project-files-watch";
const MAX_LISTED_FILES = 200;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

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
    return ref && commit ? [{ ref, commit }] : [];
  });
}

async function currentSnapshot(root: string, sessionId: string) {
  const [snapshot] = await sessionSnapshots(root, sessionId);
  if (snapshot) return snapshot;
  const ref = legacySessionRef(sessionId);
  const commit = await resolveRef(root, ref);
  return commit ? { ref, commit } : undefined;
}

async function worktreeTree(root: string) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-git-snapshot-"));
  const index = join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    try { await runGit(root, ["read-tree", "HEAD"], env); }
    catch { await runGit(root, ["read-tree", "--empty"], env); }
    await runGit(root, ["add", "--all", "--", "."], env);
    return (await runGit(root, ["write-tree"], env)).trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function saveSnapshot(root: string, sessionId: string) {
  const previous = await sessionSnapshots(root, sessionId);
  const legacyRef = legacySessionRef(sessionId);
  const legacyCommit = await resolveRef(root, legacyRef);
  const tree = await worktreeTree(root);
  const timestamp = new Date().toISOString();
  const identity = {
    GIT_AUTHOR_NAME: "Pi session snapshot",
    GIT_AUTHOR_EMAIL: "pi-session-snapshot@localhost",
    GIT_COMMITTER_NAME: "Pi session snapshot",
    GIT_COMMITTER_EMAIL: "pi-session-snapshot@localhost",
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
  const commit = (await runGit(root, ["commit-tree", tree], identity, `Pi session snapshot ${sessionId} ${timestamp}\n`)).trim();
  const snapshotName = `${timestamp.replace(/[-:.]/g, "")}-${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const ref = `${sessionRefPrefix(sessionId)}${snapshotName}`;
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

function shellQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }

function projectContext(root: string, baseline: string, current: string, files: string[]) {
  const shown = files.slice(0, MAX_LISTED_FILES);
  const omitted = files.length - shown.length;
  const paths = shown.map((path) => `- ${JSON.stringify(path)}`).join("\n");
  const command = `git -C ${shellQuote(root)} diff --find-renames ${baseline} ${current} --`;
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
  let lastError = "";

  const reportError = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) { lastError = message; ctx.ui.notify(`Git session snapshot failed: ${message}`, "warning"); }
  };

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
    snapshotQueue = snapshotQueue.then(async () => {
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
    if (event.source === "extension" || !event.text.trim() || event.text.startsWith("/")) {
      return { action: "continue" };
    }
    await snapshotQueue;
    try {
      const root = await repositoryRoot(ctx.cwd);
      if (!root) return { action: "continue" };
      const snapshot = await currentSnapshot(root, ctx.sessionManager.getSessionId());
      if (!snapshot) return { action: "continue" };
      const current = await worktreeTree(root);
      const rawPaths = await runGit(root, ["diff", "--name-only", "-z", "--find-renames", snapshot.commit, current, "--"]);
      const files = rawPaths.split("\0").filter(Boolean);
      if (!files.length) return { action: "continue" };
      lastError = "";
      pendingContext = projectContext(root, snapshot.commit, current, files);
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
