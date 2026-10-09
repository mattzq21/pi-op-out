import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, realpath } from "node:fs/promises";
import { open } from "../session-database.cjs";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { GitError, runGit } from "./git.ts";

const repositorySchema = Type.Object({ repositoryRoot: Type.String() });

async function commonRepositories(roots: string[]) {
  const repositories = new Set<string>();

  for (const root of roots) {
    try { repositories.add(await realpath((await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim())); }
    catch (error) {
      if (error instanceof GitError && error.exitCode === 128 && /not a git repository|No such file or directory/.test(error.message)) continue;
      throw error;
    }
  }

  return [...repositories];
}

export async function registerPreparedCheckpoints(sessionId: string, cwd: string, entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>, sessionPath?: string) {
  const preparation = process.env.PIOP_FORK_PREPARATION_DIRECTORY;

  if (!preparation) return;

  if (!Check(Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), sessionId)) throw new Error("Invalid preparatory checkpoint owner");
  const roots = [...new Set([cwd, ...entries.flatMap(entry => entry.type === "custom" && Check(repositorySchema, entry.data) ? [entry.data.repositoryRoot] : [])])];
  const repositories = await commonRepositories(roots);
  const destinationDirectory = process.env.PIOP_FORK_DESTINATION_DIRECTORY;
  const destination = sessionPath && destinationDirectory ? join(destinationDirectory, basename(sessionPath)) : undefined;
  const database = open(dirname(dirname(preparation)));

  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO fork_preparations VALUES (?) ON CONFLICT(directory) DO NOTHING").run(preparation);
    database.prepare("INSERT INTO fork_preparation_checkpoints VALUES (?, ?, ?) ON CONFLICT(preparation, session_id) DO UPDATE SET record_json=excluded.record_json")
      .run(preparation, sessionId, JSON.stringify({ sessionId, roots, repositories, destination }));
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  finally { database.close(); }

  await mkdir(preparation, { recursive: true, mode: 0o700 });
}
