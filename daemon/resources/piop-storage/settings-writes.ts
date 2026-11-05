import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as database from '../session-database.ts';
import { storagePublish, storageTarget } from '../storage-file.ts';

// Pi's setting changes, run by the daemon. Pi asks for them through its storage channel.

// Pi's own files in the storage folder: sign-in records, model settings and MCP sign-in records.
const FILES = new Set(["auth.json", "models.json", "models-store.json", "mcp-auth.json"]);

function absolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || resolve(value) !== value) throw new Error("Invalid settings path");
  return value;
}

function text(value, name) {
  if (typeof value !== "string") throw new Error(`Invalid ${name}`);
  return value;
}

function piFile(root, value) {
  const path = absolutePath(value);
  if (!FILES.has(basename(path)) || storageTarget(dirname(path)) !== storageTarget(root)) throw new Error("Pi cannot write " + path);
  return join(storageTarget(root), basename(path));
}

export const OPERATIONS = {
  // Saves one of Pi's settings when it still has the value that Pi read. Returns false when it changed, so Pi can try again.
  replace: (root, request) => {
    const path = absolutePath(request?.path);
    const next = text(request.next, "settings");
    const previous = request.previous === null ? null : text(request.previous, "settings");
    const db = database.connection(root);
    return database.transaction(db, "IMMEDIATE", () => {
      if ((db.prepare("SELECT body FROM sdk_settings WHERE path=?").get(path)?.body ?? null) !== previous) return false;
      db.prepare("INSERT INTO sdk_settings VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET body=excluded.body").run(path, next);
      return true;
    });
  },
  // Replaces one of Pi's files. Pi holds its own lock on the file while it asks.
  publishFile: (root, request) => {
    const path = piFile(root, request?.path);
    storagePublish(path, join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`), text(request.body, "file contents"), false);
    return null;
  },
  // Keeps the text of an agent prompt by its SHA-256, so a saved chat can show the prompt it ran with.
  promptSnapshot: (root, request) => {
    const contents = text(request?.contents, "prompt");
    const digest = createHash("sha256").update(contents).digest("hex");
    if (request.digest !== digest) throw new Error("Saved agent prompt contents changed");
    const db = database.connection(root);
    database.transaction(db, "IMMEDIATE", () => {
      db.prepare("INSERT INTO agent_prompt_snapshots VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET contents=COALESCE(agent_prompt_snapshots.contents, excluded.contents)").run(digest, contents);
      const saved = db.prepare("SELECT contents FROM agent_prompt_snapshots WHERE digest=?").get(digest)?.contents;
      if (createHash("sha256").update(String(saved)).digest("hex") !== digest) throw new Error("Saved agent prompt contents changed");
    });
    return null;
  },
};
