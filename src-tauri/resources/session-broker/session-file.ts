import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";

export async function writeSessionFile(path: string, entries: unknown[]) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try { await file.writeFile(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); }
    finally { await file.close(); }
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
