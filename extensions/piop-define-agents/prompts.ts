import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./index.ts";
import type { Agent } from "./contracts.ts";

function hasErrorCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

export async function writeConfig(value: Config, createOnly = false) {
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });

    if (createOnly) {
      try { await link(temporary, configPath); }
      catch (error) { if (!hasErrorCode(error, "EEXIST")) throw error; }
    } else await rename(temporary, configPath);
  } finally { await rm(temporary, { force: true }); }
}

export const configPath = process.env.PIOP_AGENT_CONFIG_PATH || join(dirname(fileURLToPath(import.meta.url)), "config.json");

export const DEFAULT_PROMPT_PATH = "sysprompt/default.md";

export const DEFAULT_AGENT_PROMPT_PATH = `~/${process.env.PIOP_STORAGE_DIRECTORY || ".piop"}/agents/default.md`;

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

export function effectiveAgentPromptPath(agent: Agent) {
  const path = agent.path_agentprompt;

  if (!path || agent.ignoreAgentsMd === false) return path;
  const resolved = resolvePromptPath(path);

  return resolved === resolvePromptPath(DEFAULT_AGENT_PROMPT_PATH) || resolved === join(homedir(), ".agents", "AGENTS.md") ? "" : path;
}

export async function ensurePromptFile(relativePath: string, contents: string) {
  const path = resolvePromptPath(relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });

    try { await link(temporary, path); }
    catch (error) { if (!hasErrorCode(error, "EEXIST")) throw error; }
  } finally { await rm(temporary, { force: true }); }
}

export async function snapshotPrompt(contents: string) {
  const hash = createHash("sha256").update(contents).digest("hex");
  const path = resolvePromptPath(`prompt-snapshots/${hash}.md`);
  await ensurePromptFile(path, contents);

  return path;
}

export async function ensureDefaultAgentPrompt() {
  try { await readFile(resolvePromptPath(DEFAULT_AGENT_PROMPT_PATH), "utf8");

  return; }
  catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }

  let prompt = "";

  try { prompt = await readFile(join(homedir(), ".agents", "AGENTS.md"), "utf8"); }
  catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }

  await ensurePromptFile(DEFAULT_AGENT_PROMPT_PATH, prompt);
}
