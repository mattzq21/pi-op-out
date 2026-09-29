import { open, rm } from "node:fs/promises";

export async function writeSessionFile(path: string, entries: unknown[]) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); }
  catch (error) { await rm(path, { force: true }); throw error; }
  finally { await file.close(); }
}
