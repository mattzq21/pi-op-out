import { lock } from "../../daemon/resources/file-lock.cjs";
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, mkdirSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { link, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./index.ts";
import type { Agent, AgentSnapshot } from "./contracts.ts";
import { readText as readSettings, write as writeSettings } from "../app-settings.cjs";

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

export async function readConfigDocument() {
  const body = readSettings(configPath);

  if (body === undefined) throw Object.assign(new Error("Agent definitions are unavailable"), { code: "ENOENT" });

  return { ...JSON.parse(body), revision: createHash("sha256").update(body).digest("hex") };
}

async function configLock() {
  await durableDirectory(dirname(configPath));
  const path = join(dirname(configPath), `${basename(configPath, extname(configPath))}.lock`);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  try {
    if (!(await file.stat()).isFile()) throw new Error("Agent configuration lock is not a regular file");
    if (!await lock(file.fd, false, false, 10_000)) throw new Error("Agent definitions are busy; try saving again");

    return file;
  } catch (error) { await file.close(); throw error; }
}

async function existingConfigRevision() {
  try { return (await readConfigDocument()).revision; }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return "missing"; throw error; }
}

async function publishConfig(value: Config) {
  const { revision: _revision, ...configuration } = value;
  const body = `${JSON.stringify({ ...configuration, _revision: randomUUID() }, null, 2)}\n`;
  writeSettings(configPath, body);
  value.revision = createHash("sha256").update(body).digest("hex");
  const warnings: string[] = [];

  return { revision: value.revision, warnings };
}

export async function writeConfig(value: Config, createOnly = false): Promise<{ revision?: string; warnings: string[] } | void> {
  const lock = await configLock();
  let saved: Awaited<ReturnType<typeof publishConfig>> | undefined;

  try {
    const current = await existingConfigRevision();

    if (createOnly && current !== "missing") { value.revision = current;

    return; }

    if (!createOnly && (!value.revision || value.revision !== current)) throw new Error("Agent definitions changed in another window or client. Reload them before saving.");

    saved = await publishConfig(value);

    return saved;
  } finally {
    try { await lock.close(); }
    catch (error) {
      if (!saved) throw error;
      saved.warnings.push(`Agent definitions were saved, but their lock could not be closed: ${String(error)}`);
    }
  }
}

export const configPath = process.env.PIOP_AGENT_CONFIG_PATH || join(dirname(fileURLToPath(import.meta.url)), "config.json");

/** Default prompt files live with the user's own agent files in ~/.agents, shared by every Piop profile. */
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
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(dirname(configPath), path);
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
  savePromptSnapshot(path, hash, contents);

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

function promptSnapshotDatabase(path: string) {
  const directory = dirname(dirname(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, "sessions.sqlite");
  closeSync(openSync(database, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  chmodSync(database, 0o600);
  const db = new DatabaseSync(database);

  try {
    db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS agent_prompt_snapshots (digest TEXT PRIMARY KEY, contents TEXT); BEGIN IMMEDIATE;");

    return db;
  } catch (error) { db.close(); throw error; }
}

function verifiedPrompt(contents: string, digest: string) {
  if (createHash("sha256").update(contents).digest("hex") !== digest) throw new Error("Saved agent prompt contents changed");

  return contents;
}

function savePromptSnapshot(path: string, digest: string, contents: string) {
  verifiedPrompt(contents, digest);
  const db = promptSnapshotDatabase(path);

  try {
    db.prepare("INSERT INTO agent_prompt_snapshots VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET contents=COALESCE(agent_prompt_snapshots.contents, excluded.contents)").run(digest, contents);
    verifiedPrompt(String(db.prepare("SELECT contents FROM agent_prompt_snapshots WHERE digest=?").get(digest)?.contents), digest);
    db.exec("COMMIT");
  } finally { db.close(); }
}

export async function readPrompt(path: string): Promise<string> {
  const digest = basename(path, ".md");

  if (basename(dirname(path)) !== "prompt-snapshots" || !/^[a-f0-9]{64}\.md$/.test(basename(path))) return readFile(path, "utf8");
  const db = promptSnapshotDatabase(path);
  let contents: string | null;

  try {
    const row = db.prepare("SELECT contents FROM agent_prompt_snapshots WHERE digest=?").get(digest);
    contents = row ? row.contents === null ? null : verifiedPrompt(String(row.contents), digest) : null;
    db.exec("COMMIT");
  } finally { db.close(); }

  if (contents === null) throw Object.assign(new Error(`Saved agent prompt is unavailable: ${path}`), { code: "ENOENT" });

  return contents;
}
