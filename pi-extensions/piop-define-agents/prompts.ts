import { createHash, randomUUID } from "node:crypto";
import * as storageDatabase from "../../daemon/resources/session-database/index.ts";
import { storageChannel } from "../../daemon/resources/session-database/index.ts";
import { bodyText, DEFINITIONS, isNamedAgent, revisionOf, saveConfig, saveMove, saveProject, type ProjectChange } from "./definitions-storage.ts";
import { execFile } from "node:child_process";
import { link, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./index.ts";
import type { Agent, AgentSnapshot } from "./contracts.ts";

function hasErrorCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

async function syncPath(path: string) {
  const file = await open(path, "r");

  try { await file.sync(); }
  finally { await file.close(); }
}

async function durableDirectory(path: string) {
  await mkdir(resolve(path), { recursive: true, mode: 0o700 });

  for (let current = await realpath(path); ; current = dirname(current)) {
    await syncPath(current);

    if (current === dirname(current)) break;
  }
}

async function writeTemporary(path: string, contents: string) {
  const file = await open(path, "wx", 0o600);

  try { await file.writeFile(contents); await file.sync(); }
  finally { await file.close(); }
}

export const storageRoot = process.env.PIOP_STORAGE_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));

export const agentDirectory = join(storageRoot, "piop-define-agents");

// read's result, or undefined when the storage database of root does not exist.
function stored<T>(root: string, read: () => T): T | undefined {
  return storageDatabase.databaseExists(root) ? read() : undefined;
}

export { isNamedAgent };

export async function readConfigDocument() {
  const body = bodyText(stored(storageRoot, () => storageDatabase.applicationSetting(storageRoot, DEFINITIONS)));

  if (body === undefined) throw Object.assign(new Error("Agent definitions are unavailable"), { code: "ENOENT" });

  return { ...JSON.parse(body), revision: revisionOf(body) };
}

export async function writeConfig(value: Config, createOnly = false): Promise<{ revision?: string; warnings: string[] } | void> {
  const saved = saveConfig(storageRoot, value, createOnly);
  value.revision = saved.revision;

  return saved.result;
}

export type ProjectDocument = { agents: unknown[]; defaultAgent?: string };

export type { ProjectChange };

export function readProjectDocument(directory: string): ProjectDocument & { revision: string } {
  const body = bodyText(stored(storageRoot, () => storageDatabase.projectAgentDefinition(storageRoot, directory)));

  if (body === undefined) return { agents: [], revision: "missing" };
  const { agents, defaultAgent } = JSON.parse(body);

  return { agents, ...(defaultAgent ? { defaultAgent } : {}), revision: revisionOf(body) };
}

export function writeProjectDocument(directory: string, change: ProjectChange): string {
  return saveProject(storageRoot, directory, change);
}

// A change of one project's agents when an agent moves: the agent named remove leaves, and add joins.
// With revision, the change applies only to the project agents saved at that revision.
export type ProjectEdit = { directory: string; revision?: string; remove?: string; add?: unknown };

export function writeAgentMove(global: Config | undefined, projects: ProjectEdit[]): string | undefined {
  return saveMove(storageRoot, global, projects);
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else resolveRun({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
  }));
}

export async function projectDirectory(cwd: string): Promise<string> {
  const expanded = cwd === "~" ? homedir() : cwd.startsWith("~/") ? join(homedir(), cwd.slice(2)) : cwd;

  if (!isAbsolute(expanded)) throw new Error(`Project directory must be an absolute path: ${cwd}`);
  const directory = await realpath(expanded);
  let top;

  try { top = await git(directory, ["rev-parse", "--show-toplevel"]); }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return directory; throw error; }

  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr)) return directory;
    throw new Error(`Could not check for a Git repository in ${directory}: ${top.stderr.trim()}`);
  }

  if (await realpath(top.stdout.trim()) !== directory) return directory;
  const list = await git(directory, ["worktree", "list", "--porcelain"]);

  if (list.code !== 0) throw new Error(`Could not list the worktrees of ${directory}: ${list.stderr.trim()}`);
  const [first = ""] = list.stdout.split("\n\n");
  const main = /^worktree (.+)$/m.exec(first)?.[1];

  if (!main) throw new Error(`Could not find the main worktree of ${directory}`);

  return /^bare$/m.test(first) ? directory : realpath(main);
}

export const DEFAULT_PROMPT_PATH = "~/.agents/prompts/system/default.md";

export const DEFAULT_AGENT_PROMPT_PATH = "~/.agents/AGENTS.md";

export const DEFAULT_SYSTEM_PROMPT = `You are an expert coding assistant operating inside a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:

- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:

- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files`;

export function resolvePromptPath(path: string) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(agentDirectory, path);
}

export async function ensurePromptFile(relativePath: string, contents: string) {
  const path = resolvePromptPath(relativePath);
  await durableDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeTemporary(temporary, contents);

    try { await link(temporary, path); }
    catch (error) { if (!hasErrorCode(error, "EEXIST")) throw error; await syncPath(path); }
  } finally { await rm(temporary, { force: true }); }

  await syncPath(dirname(path));
}

export async function snapshotPrompt(contents: string) {
  const hash = createHash("sha256").update(contents).digest("hex");
  const path = resolvePromptPath(`prompt-snapshots/${hash}.md`);
  savePromptSnapshot(hash, contents);

  return path;
}

export async function snapshotPrompts(definition: Agent, systemPrompt: string, agentPrompt: string): Promise<AgentSnapshot> {
  return { version: 2, definition: { ...definition,
    path_systemprompt: await snapshotPrompt(systemPrompt),
    path_agent_prompt: agentPrompt ? await snapshotPrompt(agentPrompt) : "",
  } };
}

export async function ensureDefaultAgentPrompt() {
  await ensurePromptFile(DEFAULT_AGENT_PROMPT_PATH, "");
}

function verifiedPrompt(contents: string, digest: string) {
  if (createHash("sha256").update(contents).digest("hex") !== digest) throw new Error("Saved agent prompt contents changed");

  return contents;
}

function snapshotRoot(path: string) { return dirname(dirname(dirname(path))); }

// The daemon saves the snapshot in the storage of this Pi.
function savePromptSnapshot(digest: string, contents: string) {
  verifiedPrompt(contents, digest);
  storageChannel.call("settings.promptSnapshot", { digest, contents });
}

export async function readPrompt(path: string): Promise<string> {
  const digest = basename(path, ".md");

  if (basename(dirname(path)) !== "prompt-snapshots" || !/^[a-f0-9]{64}\.md$/.test(basename(path))) return readFile(path, "utf8");
  const root = snapshotRoot(path);
  const saved = stored(root, () => storageDatabase.agentPromptSnapshot(root, digest));
  const contents = saved === undefined ? null : verifiedPrompt(String(saved), digest);

  if (contents === null) throw Object.assign(new Error(`Saved agent prompt is unavailable: ${path}`), { code: "ENOENT" });

  return contents;
}
