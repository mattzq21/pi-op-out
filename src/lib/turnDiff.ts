import type { ChatMessage, FileChangeSnapshot, GitDiffSnapshot } from "../types";
import { parseDiff, type DiffFile } from "./diff";

function absolutePath(path: string, cwd: string) {
  const input = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of input.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); }
  return `/${parts.join("/")}`;
}

function gitDiffSource(snapshot: GitDiffSnapshot | null | undefined, fallbackRoot: string): Exclude<GitDiffSnapshot, string> {
  return typeof snapshot === "string" ? { patch: snapshot, repositoryRoot: fallbackRoot } : snapshot ?? { patch: "", repositoryRoot: fallbackRoot };
}

export function mergeDiffSnapshots(gitPatch: GitDiffSnapshot | null, snapshots: FileChangeSnapshot[], cwd: string): GitDiffSnapshot | null {
  const source = gitDiffSource(gitPatch, snapshots.at(-1)?.cwd ?? cwd);
  const covered = new Set(parseDiff(source.patch).flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])].map((path) => absolutePath(path, source.repositoryRoot))));
  const patches = source.patch ? [source.patch] : [];
  const validSnapshots = validSnapshotsWithCwd(snapshots);
  for (const snapshot of validSnapshots) for (const patch of snapshot.patch.split(/(?=^diff --git )/m)) {
    const file = parseDiff(patch)[0];
    if (file && !covered.has(absolutePath(file.path, snapshot.cwd))) patches.push(patch);
  }
  const patch = patches.join("\n");
  const toolPaths = [...(source.toolPaths ?? []), ...snapshots.flatMap((snapshot) => snapshot.toolPaths ?? [])];
  return patch ? { patch, repositoryRoot: source.repositoryRoot, toolPaths } : null;
}

export function turnDiff(messages: ChatMessage[], gitPatch?: GitDiffSnapshot, cwd = "") {
  const files = new Map<string, DiffFile>();
  const covered = new Set<string>();
  const snapshots = (Array.isArray(messages) ? messages : []).flatMap((message) => Array.isArray(message?.fileChanges) ? message.fileChanges.filter((snapshot) => snapshot && typeof snapshot.patch === "string" && Array.isArray(snapshot.toolCallIds) && Array.isArray(snapshot.paths)) : []);
  const base = snapshots.at(-1)?.cwd ?? cwd;
  const source = gitDiffSource(gitPatch, base);
  const warnings = [...new Set(snapshots.flatMap((snapshot) => Array.isArray(snapshot.warnings) ? snapshot.warnings.filter((warning): warning is string => typeof warning === "string") : []))];
  const add = (file: DiffFile, sourceCwd: string) => {
    const key = absolutePath(file.path, sourceCwd);
    const previous = files.get(key);
    const display = base && key.startsWith(`${base.replace(/\/$/, "")}/`) ? key.slice(base.replace(/\/$/, "").length + 1) : key;
    if (previous) { previous.lines.push({ kind: "meta", text: "Subsequent changes" }, ...file.lines); previous.additions += file.additions; previous.deletions += file.deletions; }
    else files.set(key, { ...file, id: key, path: display });
  };
  for (const file of parseDiff(source.patch)) {
    add(file, source.repositoryRoot); covered.add(absolutePath(file.path, source.repositoryRoot));
    if (file.oldPath) covered.add(absolutePath(file.oldPath, source.repositoryRoot));
  }
  addSnapshotDiffs(snapshots, covered, add);
  for (const message of messages) addToolDiff(message, snapshots, source, base, covered, add);
  return { files: [...files.values()], warnings };
}

function validSnapshotsWithCwd(snapshots: FileChangeSnapshot[]) {
  return Array.isArray(snapshots) ? snapshots.filter((snapshot) => snapshot && typeof snapshot.patch === "string" && typeof snapshot.cwd === "string") : [];
}

type AddDiff = (file: DiffFile, cwd: string) => void;
function addSnapshotDiffs(snapshots: FileChangeSnapshot[], covered: Set<string>, add: AddDiff) {
  for (const snapshot of snapshots) for (const file of parseDiff(typeof snapshot.patch === "string" ? snapshot.patch : "")) {
    if (!covered.has(absolutePath(file.path, snapshot.cwd))) add(file, snapshot.cwd);
  }
}
function addToolDiff(message: ChatMessage, snapshots: FileChangeSnapshot[], source: Exclude<GitDiffSnapshot, string>, base: string, covered: Set<string>, add: AddDiff) {
  if (message.role !== "tool" || message.toolStatus === "running" || message.toolStatus === "error") return;
  const { path, patch } = toolPatch(message);
  const { toolCwd, canonicalToolPath, snapshotPaths } = toolPaths(message, snapshots, source, base);
  if (typeof patch !== "string") return;
  for (const file of parseDiff(patch, path)) {
    const canonical = { ...file, path: canonicalToolPath(file.path), ...(file.oldPath ? { oldPath: canonicalToolPath(file.oldPath) } : {}) };
    const key = absolutePath(canonical.path, toolCwd);
    if (!covered.has(key) && !snapshotPaths.has(key)) add(canonical, toolCwd);
  }
}

function toolPatch(message: ChatMessage) {
  if (message.toolDiff) return message.toolDiff;
  const name = message.toolName?.split(".").at(-1);
  const input = message.toolInput as { path?: unknown; patch?: unknown; input?: unknown } | undefined;
  const details = message.details as { patch?: unknown; diff?: unknown } | undefined;
  const path = typeof input?.path === "string" ? input.path : undefined;
  const patch = typeof details?.patch === "string" ? details.patch : fallbackToolPatch(name, details, input);
  return { path, patch };
}

function fallbackToolPatch(name: string | undefined, details: { diff?: unknown } | undefined, input: { patch?: unknown; input?: unknown } | undefined) {
  return name === "edit" && typeof details?.diff === "string" ? details.diff : name === "apply_patch" ? input?.patch ?? input?.input : undefined;
}

function toolPaths(message: ChatMessage, snapshots: FileChangeSnapshot[], source: Exclude<GitDiffSnapshot, string>, base: string) {
  const toolCallId = message.toolCallId ?? message.id;
  const snapshot = snapshots.find((candidate) => Array.isArray(candidate.toolCallIds) && candidate.toolCallIds.includes(toolCallId));
  const toolCwd = snapshot?.cwd ?? base;
  const mappings = [...(snapshot?.toolPaths ?? []), ...(source.toolPaths ?? [])].filter((mapping) => mapping.toolCallId === toolCallId);
  const canonicalToolPath = (path: string) => {
    const exact = mappings.find((mapping) => mapping.path === path || mapping.absolutePath === path || mapping.canonicalPath === path);
    return (exact ?? mappings.find((mapping) => absolutePath(mapping.absolutePath, toolCwd) === absolutePath(path, toolCwd)))?.canonicalPath ?? path;
  };
  const snapshotPaths = new Set(Array.isArray(snapshot?.paths) ? snapshot.paths.filter((path): path is string => typeof path === "string").map((path) => absolutePath(path, toolCwd)) : []);
  return { toolCwd, canonicalToolPath, snapshotPaths };
}
