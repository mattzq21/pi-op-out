import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { link, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
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

const DEFINITIONS = "agent-definitions.json";

function openDatabase(root: string) {
  const path = join(root, "sessions.sqlite");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Database path must not be a symbolic link");
  const db = new DatabaseSync(path);

  try {
    fs.chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB);
      CREATE TABLE IF NOT EXISTS agent_prompt_snapshots (digest TEXT PRIMARY KEY, contents TEXT);
      CREATE TABLE IF NOT EXISTS project_agent_definitions (directory TEXT PRIMARY KEY, body BLOB NOT NULL);`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function readRow(root: string, table: "application_settings" | "agent_prompt_snapshots" | "project_agent_definitions", sql: string, key: string): Record<string, unknown> | undefined {
  const path = join(root, "sessions.sqlite");
  let metadata;

  try { metadata = fs.lstatSync(path); }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return undefined; throw error; }

  if (!metadata.isFile()) throw new Error("Settings database is not a regular file");
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    db.exec("PRAGMA busy_timeout=10000");

    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return undefined;

    return db.prepare(sql).get(key) as Record<string, unknown> | undefined;
  } finally { db.close(); }
}

function transaction<T>(change: (db: DatabaseSync) => T, root = storageRoot): T {
  const db = openDatabase(root);

  try {
    db.exec("BEGIN IMMEDIATE");

    try { const result = change(db); db.exec("COMMIT"); return result; }
    catch (error) {
      if (!db.isTransaction) throw error;

      try { db.exec("ROLLBACK"); }
      catch (failure) {
        if (!(error instanceof Error)) throw new AggregateError([error, failure], "Agent definitions change failed; rollback also failed");
        error.message += `; rollback also failed: ${failure instanceof Error ? failure.message : String(failure)}`;
        Object.assign(error, { rollbackError: failure });
      }

      throw error;
    }
  } finally { db.close(); }
}

function bodyText(row: Record<string, unknown> | undefined): string | undefined {
  return row?.body == null ? undefined : Buffer.from(row.body as Uint8Array).toString("utf8");
}

function storedBody(db: DatabaseSync, name: string): string | undefined {
  return bodyText(db.prepare("SELECT body FROM application_settings WHERE name=?").get(name));
}

function revisionOf(body: string) { return createHash("sha256").update(body).digest("hex"); }

export const isNamedAgent = (agent: unknown): agent is { name: string } => Check(Type.Object({ name: Type.String({ pattern: "\\S" }) }), agent);

export async function readConfigDocument() {
  const body = bodyText(readRow(storageRoot, "application_settings", "SELECT body FROM application_settings WHERE name=?", DEFINITIONS));

  if (body === undefined) throw Object.assign(new Error("Agent definitions are unavailable"), { code: "ENOENT" });

  return { ...JSON.parse(body), revision: revisionOf(body) };
}

function putConfig(db: DatabaseSync, value: Config, createOnly: boolean): { revision?: string; warnings: string[] } | void {
  const current = storedBody(db, DEFINITIONS);
  const revision = current === undefined ? "missing" : revisionOf(current);

  if (createOnly && current !== undefined) { value.revision = revision;

  return; }

  if (!createOnly && (!value.revision || value.revision !== revision)) throw new Error("Agent definitions changed in another window or client. Reload them before saving.");
  const stored = current === undefined ? undefined : JSON.parse(current);
  const unnamed = Array.isArray(stored?.agents) ? stored.agents.filter((agent: unknown) => !isNamedAgent(agent)) : [];
  const { revision: _revision, ...configuration } = value;
  const body = `${JSON.stringify({ ...configuration, agents: [...configuration.agents, ...unnamed], _revision: randomUUID() }, null, 2)}\n`;
  db.prepare("INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body").run(DEFINITIONS, Buffer.from(body));
  value.revision = revisionOf(body);

  return { revision: value.revision, warnings: [] };
}

export async function writeConfig(value: Config, createOnly = false): Promise<{ revision?: string; warnings: string[] } | void> {
  return transaction(db => {
    const result = putConfig(db, value, createOnly);
    requireConsistentDefinitions(db);

    return result;
  });
}

function namedAgents(document: { agents?: unknown } | undefined): string[] {
  return Array.isArray(document?.agents) ? document.agents.filter(isNamedAgent).map(agent => agent.name) : [];
}

function storedGlobalNames(db: DatabaseSync): Set<string> {
  const body = storedBody(db, DEFINITIONS);

  return new Set(["general", ...namedAgents(body === undefined ? undefined : JSON.parse(body))]);
}

function requireConsistentDefinitions(db: DatabaseSync) {
  const global = storedGlobalNames(db);

  for (const row of db.prepare("SELECT directory, body FROM project_agent_definitions").all()) {
    const directory = String(row.directory);
    const project: ProjectDocument = JSON.parse(String(bodyText(row)));
    const names = namedAgents(project);
    const shared = names.find(name => global.has(name));

    if (shared) throw new Error(`Agent name "${shared}" is used by a global agent and by the project ${directory}. Project agent names must be different.`);

    if (project.defaultAgent && !global.has(project.defaultAgent) && !names.includes(project.defaultAgent)) throw new Error(`The project ${directory} uses agent "${project.defaultAgent}" as its default agent, but no such agent exists. Choose another default agent in Edit project first.`);
  }
}

export type ProjectDocument = { agents: unknown[]; defaultAgent?: string };

export type ProjectChange = { revision: string; agents?: unknown[]; defaultAgent?: string | null };

export function readProjectDocument(directory: string): ProjectDocument & { revision: string } {
  const body = bodyText(readRow(storageRoot, "project_agent_definitions", "SELECT body FROM project_agent_definitions WHERE directory=?", directory));

  if (body === undefined) return { agents: [], revision: "missing" };
  const { agents, defaultAgent } = JSON.parse(body);

  return { agents, ...(defaultAgent ? { defaultAgent } : {}), revision: revisionOf(body) };
}

function putProject(db: DatabaseSync, directory: string, change: ProjectChange): string {
  const current = bodyText(db.prepare("SELECT body FROM project_agent_definitions WHERE directory=?").get(directory));

  if (change.revision !== (current === undefined ? "missing" : revisionOf(current))) throw new Error("Project agent definitions changed in another window or client. Reload them before saving.");
  const stored: ProjectDocument = current === undefined ? { agents: [] } : JSON.parse(current);
  const agents = change.agents ?? stored.agents;
  const defaultAgent = change.defaultAgent === undefined ? stored.defaultAgent : change.defaultAgent ?? undefined;

  if (!namedAgents({ agents }).length && !defaultAgent) {
    db.prepare("DELETE FROM project_agent_definitions WHERE directory=?").run(directory);

    return "missing";
  }

  const body = `${JSON.stringify({ agents, ...(defaultAgent ? { defaultAgent } : {}) }, null, 2)}\n`;
  db.prepare("INSERT INTO project_agent_definitions (directory, body) VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET body=excluded.body").run(directory, Buffer.from(body));

  return revisionOf(body);
}

export function writeProjectDocument(directory: string, change: ProjectChange): string {
  return transaction(db => {
    const revision = putProject(db, directory, change);
    requireConsistentDefinitions(db);

    return revision;
  });
}

export type ProjectEdit = { directory: string; change: (stored: ProjectDocument, revision: string) => ProjectChange };

export function writeAgentMove(global: Config | undefined, projects: ProjectEdit[]): string | undefined {
  return transaction(db => {
    const saved = global && putConfig(db, global, false);

    if (global && !saved?.revision) throw new Error("Agent definitions were not saved");

    for (const { directory, change } of projects) {
      const current = bodyText(db.prepare("SELECT body FROM project_agent_definitions WHERE directory=?").get(directory));
      const stored: ProjectDocument = current === undefined ? { agents: [] } : JSON.parse(current);
      putProject(db, directory, change(stored, current === undefined ? "missing" : revisionOf(current)));
    }

    requireConsistentDefinitions(db);

    return saved ? saved.revision : undefined;
  });
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

export function moveLegacyDefinitions() {
  const path = join(agentDirectory, "sessions.sqlite");

  if (!fs.existsSync(path)) return;
  const legacy = new DatabaseSync(path, { readOnly: true });

  try {
    const tables = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    const body = tables.has("application_settings") ? storedBody(legacy, "config.json") : undefined;
    const snapshots = tables.has("agent_prompt_snapshots") ? legacy.prepare("SELECT digest, contents FROM agent_prompt_snapshots").all() : [];
    transaction(db => {
      if (body !== undefined) db.prepare("INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").run(DEFINITIONS, Buffer.from(body));
      const insert = db.prepare("INSERT INTO agent_prompt_snapshots VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET contents=COALESCE(agent_prompt_snapshots.contents, excluded.contents)");

      for (const row of snapshots) insert.run(String(row.digest), row.contents === null ? null : String(row.contents));
    });
  } finally { legacy.close(); }

  for (const name of ["sessions.sqlite", "sessions.sqlite-wal", "sessions.sqlite-shm", "config.lock"]) fs.rmSync(join(agentDirectory, name), { force: true });
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

function verifiedPrompt(contents: string, digest: string) {
  if (createHash("sha256").update(contents).digest("hex") !== digest) throw new Error("Saved agent prompt contents changed");

  return contents;
}

function snapshotRoot(path: string) { return dirname(dirname(dirname(path))); }

function savePromptSnapshot(path: string, digest: string, contents: string) {
  verifiedPrompt(contents, digest);
  transaction(db => {
    db.prepare("INSERT INTO agent_prompt_snapshots VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET contents=COALESCE(agent_prompt_snapshots.contents, excluded.contents)").run(digest, contents);
    verifiedPrompt(String(db.prepare("SELECT contents FROM agent_prompt_snapshots WHERE digest=?").get(digest)?.contents), digest);
  }, snapshotRoot(path));
}

export async function readPrompt(path: string): Promise<string> {
  const digest = basename(path, ".md");

  if (basename(dirname(path)) !== "prompt-snapshots" || !/^[a-f0-9]{64}\.md$/.test(basename(path))) return readFile(path, "utf8");
  const row = readRow(snapshotRoot(path), "agent_prompt_snapshots", "SELECT contents FROM agent_prompt_snapshots WHERE digest=?", digest);
  const contents = row && row.contents !== null ? verifiedPrompt(String(row.contents), digest) : null;

  if (contents === null) throw Object.assign(new Error(`Saved agent prompt is unavailable: ${path}`), { code: "ENOENT" });

  return contents;
}
