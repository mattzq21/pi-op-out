import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";

const repositorySchema = Type.Object({ repositoryRoot: Type.String() });

async function sync(directory: string) {
  const file = await open(directory, "r");

  try { await file.sync(); } finally { await file.close(); }
}

export async function registerPreparedCheckpoints(sessionId: string, cwd: string, entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>) {
  const preparation = process.env.PIOP_FORK_PREPARATION_DIRECTORY;

  if (!preparation) return;

  if (!Check(Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), sessionId)) throw new Error("Invalid preparatory checkpoint owner");
  const roots = [...new Set([cwd, ...entries.flatMap(entry => entry.type === "custom" && Check(repositorySchema, entry.data) ? [entry.data.repositoryRoot] : [])])];
  const directory = join(preparation, "checkpoint-owners");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sync(preparation);
  const temporary = join(directory, `.${sessionId}.${randomUUID()}.tmp`);

  try {
    const file = await open(temporary, "wx", 0o600);

    try { await file.writeFile(JSON.stringify({ sessionId, roots })); await file.sync(); }
    finally { await file.close(); }

    await rename(temporary, join(directory, `${sessionId}.json`));
    await sync(directory);
  } finally { await rm(temporary, { force: true }); }
}
