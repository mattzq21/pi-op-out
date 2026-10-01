import type { GitDiffSnapshot } from "../types";
import { parseDiff } from "./diff";
import { gitPatchSchema } from "./diffSchemas";

export function turnDiff(gitPatch?: GitDiffSnapshot) {
  const { patch } = gitPatchSchema.parse(gitPatch);

  const warnings: string[] = [];

  return { files: parseDiff(patch), warnings };
}
