import type { GitDiffSnapshots } from "../../../src/types";

export function readStoreLocked(filename: string): { snapshots: GitDiffSnapshots };
