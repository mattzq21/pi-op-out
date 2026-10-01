import type { GitDiffSnapshot } from "../types";
import { parseDiff } from "./diff";

export function turnDiff(gitPatch?: GitDiffSnapshot) {
  const patch = typeof gitPatch === "string" ? gitPatch : gitPatch?.patch ?? "";

  const warnings: string[] = [];

  return { files: parseDiff(patch), warnings };
}
