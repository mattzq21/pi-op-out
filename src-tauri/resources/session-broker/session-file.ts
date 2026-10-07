import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeSessionFile(path: string, entries: unknown[]) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try { await file.writeFile(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); await file.sync(); }
    finally { await file.close(); }

    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }

  const directory = await open(dirname(path), "r");

  try { await directory.sync(); }
  finally { await directory.close(); }
}
