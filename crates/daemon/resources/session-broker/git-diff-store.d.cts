import type { GitDiffSnapshots } from "../../../../clients/ui/types";

export function readStoreLocked(filename: string): { snapshots: GitDiffSnapshots };

export function copyRetainedStoreLocked(filename: string, destination: string, retainedIds: ReadonlySet<string>, sessionId: string): void;
