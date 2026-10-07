import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { closeSync, fsyncSync, linkSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { acquireSessionReferencePublication } from "../sdk-storage.mjs";

export async function writeSessionFile(path: string, entries: unknown[]) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try { await file.writeFile(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); await file.sync(); }
    finally { await file.close(); }

    const release = acquireSessionReferencePublication(path);

    try {
      linkSync(temporary, path);
      const directory = openSync(dirname(path), "r");

      try { fsyncSync(directory); }
      finally { closeSync(directory); }
    } finally { release(); }
  } finally { await rm(temporary, { force: true }); }
}
