import type { DatabaseSync } from "node:sqlite";

export function open(root: string): DatabaseSync;
export function register(database: DatabaseSync, sessionId: string, sessionPath: string): void;
export function storageRoot(file: string): string;
export function markCleanup(root: string, kind: "goal" | "worktree"): void;
export function recordWorktree(container: string, target: string, branch: string, parentBranch: string | null): void;
