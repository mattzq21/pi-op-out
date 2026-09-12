import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY = "piop-file-changes";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_FILES = 256;
const assets = dirname(fileURLToPath(import.meta.url));
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Baseline = { content: string | null; capturedAt: number };
type ToolPathMapping = { toolCallId: string; path: string; absolutePath: string; canonicalPath: string };
type Capture = { files: Map<string, Baseline>; bytes: number; toolCallIds: Set<string>; toolPaths: ToolPathMapping[]; warnings: Set<string> };
type Journal = { directory: string; capture: Capture; capturedAt: number };
const newCapture = (): Capture => ({ files: new Map(), bytes: 0, toolCallIds: new Set(), toolPaths: [], warnings: new Set() });
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

async function textFile(path: string, limit = MAX_FILE_BYTES): Promise<string | null> {
  let handle;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > limit) throw new Error("Not a small regular file");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit || buffer.subarray(0, size).includes(0)) throw new Error("Binary or oversized file");
    return decoder.decode(buffer.subarray(0, size));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
}

function absoluteToolPath(path: string, cwd: string) {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`;
}

async function canonicalPath(absolute: string) {
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(await canonicalParent(dirname(absolute)), absolute.split("/").at(-1)!);
  }
}

async function canonicalParent(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalParent(dirname(path)), path.split("/").at(-1)!);
  }
}

function remember(capture: Capture, path: string, content: string | null, capturedAt: number) {
  const previous = capture.files.get(path);
  if (previous && previous.capturedAt <= capturedAt) return;
  const bytes = Buffer.byteLength(content ?? "");
  const total = capture.bytes - Buffer.byteLength(previous?.content ?? "") + bytes;
  if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || (!previous && capture.files.size >= MAX_FILES)) {
    capture.warnings.add("Some file changes exceeded the capture size limit."); return;
  }
  capture.files.set(path, { content, capturedAt }); capture.bytes = total;
}

async function collectJournal(journal: Journal) {
  try {
    for (let index = 0; index < 32; index++) {
      const raw = await textFile(join(journal.directory, `${index}.json`), MAX_TOTAL_BYTES);
      if (raw === null) break;
      const record = JSON.parse(raw);
      if (typeof record.path !== "string" || !isAbsolute(record.path) || record.skip || (record.content !== null && typeof record.content !== "string")) {
        journal.capture.warnings.add("Some shell changes could not be captured."); continue;
      }
      const skipped = `skipped-${createHash("sha256").update(record.path).digest("hex")}`;
      if (await textFile(join(journal.directory, skipped)) !== null) continue;
      remember(journal.capture, record.path, record.content, typeof record.capturedAt === "number" && Number.isFinite(record.capturedAt) ? record.capturedAt : journal.capturedAt);
      if (index === 31) journal.capture.warnings.add("Shell file capture reached its 32-file limit; Git changes are included where available.");
    }
    if (await textFile(join(journal.directory, "incomplete")) !== null) journal.capture.warnings.add("Some shell changes could not be captured because snapshots overlapped, failed, or exceeded capture limits. Git changes are included where available.");
  } catch { journal.capture.warnings.add("Some shell changes could not be captured."); }
  finally { await rm(journal.directory, { recursive: true, force: true }).catch(() => undefined); }
}

async function filePatch(path: string, before: string | null, after: string | null, directory: string) {
  if (before === after) return "";
  const oldPath = join(directory, "before"); const newPath = join(directory, "after");
  await writeFile(oldPath, before ?? "", { mode: 0o600 });
  await writeFile(newPath, after ?? "", { mode: 0o600 });
  const diff = await new Promise<string>((resolveDiff, reject) => {
    execFile("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--", oldPath, newPath],
      { encoding: "utf8", maxBuffer: MAX_TOTAL_BYTES, timeout: 5000 }, (error, stdout) => {
        if (error && (error as { code?: unknown }).code !== 1) reject(error);
        else resolveDiff(stdout);
      });
  });
  const hunk = diff.indexOf("\n@@ ");
  const oldName = JSON.stringify(`a/${path}`); const newName = JSON.stringify(`b/${path}`);
  return `diff --git ${oldName} ${newName}\n${before === null ? "new file mode 100644\n" : after === null ? "deleted file mode 100644\n" : ""}--- ${before === null ? "/dev/null" : oldName}\n+++ ${after === null ? "/dev/null" : newName}\n${hunk < 0 ? "" : diff.slice(hunk + 1)}`;
}

export function registerFileChanges(pi: ExtensionAPI) {
  let capture = newCapture();
  const journals = new Map<string, Journal>();

  pi.on("agent_start", () => { capture = newCapture(); });
  pi.on("tool_call", async (event, ctx) => {
    const current = capture;
    const name = event.toolName.split(".").at(-1);
    if (!["edit", "write", "apply_patch", "bash", "exec_command"].includes(name ?? "")) return;
    current.toolCallIds.add(event.toolCallId);
    const input = event.input as Record<string, unknown>;
    if (name === "bash" || name === "exec_command") {
      const key = name === "bash" ? "command" : "cmd";
      if (typeof input[key] !== "string") return;
      let directory: string | undefined;
      try {
        directory = await mkdtemp(join(tmpdir(), "piop-file-changes-"));
        journals.set(event.toolCallId, { directory, capture: current, capturedAt: Date.now() });
        const preload = `--require ${JSON.stringify(join(assets, "node_fs.cjs"))}`;
        input[key] = `export PIOP_DIFF_JOURNAL=${quote(directory)}\nexport PYTHONPATH=${quote(assets)}\${PYTHONPATH:+:"$PYTHONPATH"}\nexport NODE_OPTIONS=${quote(preload)}\${NODE_OPTIONS:+ "$NODE_OPTIONS"}\n${input[key]}`;
      } catch {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        current.warnings.add("Shell file capture could not be started.");
      }
      return;
    }
    const paths = typeof input.path === "string" ? [input.path] : [];
    if (name === "apply_patch") {
      const patch = input.patch ?? input.input;
      if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
    }
    for (const path of paths) {
      try {
        const absolute = absoluteToolPath(path, ctx.cwd);
        const canonical = await canonicalPath(absolute);
        current.toolPaths.push({ toolCallId: event.toolCallId, path, absolutePath: absolute, canonicalPath: canonical });
        if (!current.files.has(canonical)) remember(current, canonical, await textFile(canonical), Date.now());
      } catch { current.warnings.add(`Could not capture ${path}.`); }
    }
  });
  pi.on("tool_result", async (event) => {
    const journal = journals.get(event.toolCallId);
    if (!journal) return;
    journals.delete(event.toolCallId);
    await collectJournal(journal);
  });

  const finish = async (ctx: ExtensionContext) => {
    const current = capture; capture = newCapture();
    for (const [id, journal] of journals) {
      if (journal.capture !== current) continue;
      journals.delete(id); await collectJournal(journal);
    }
    if (!current.toolCallIds.size) return;
    const paths: string[] = []; const patches: string[] = [];
    let directory: string | undefined; let patchBytes = 0;
    try {
      if (current.files.size) directory = await mkdtemp(join(tmpdir(), "piop-diff-"));
      for (const [path, before] of current.files) {
        try {
          const patch = await filePatch(path, before.content, await textFile(path), directory!);
          patchBytes += Buffer.byteLength(patch);
          if (patchBytes > MAX_TOTAL_BYTES) { current.warnings.add("Some file diffs exceeded the capture size limit."); continue; }
          paths.push(path); if (patch) patches.push(patch);
        } catch { current.warnings.add(`Could not compare ${path}.`); }
      }
    } catch { current.warnings.add("File changes could not be compared."); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    pi.appendEntry(ENTRY, { cwd: await realpath(ctx.cwd).catch(() => ctx.cwd), toolCallIds: [...current.toolCallIds], toolPaths: current.toolPaths, paths, patch: patches.join("\n"), warnings: [...current.warnings] });
  };
  pi.on("agent_end", (_event, ctx) => finish(ctx));
  pi.on("agent_settled", (_event, ctx) => finish(ctx));
  pi.on("session_shutdown", async () => {
    for (const journal of journals.values()) await rm(journal.directory, { recursive: true, force: true }).catch(() => undefined);
    journals.clear();
  });
}
