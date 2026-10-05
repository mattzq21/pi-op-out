import { z } from "zod";
import { toolPathSchema } from "./messageSchemas";

export const gitDiffSnapshotSchema = z.union([
  z.string(),
  z.object({ patch: z.string(), repositoryRoot: z.string(), toolPaths: z.array(toolPathSchema).optional() }),
]);

const diffLineSchema = z.object({
  kind: z.enum(["add", "delete", "context", "meta"]), text: z.string(),
  oldLine: z.number().optional(), newLine: z.number().optional(),
  parts: z.array(z.object({ text: z.string(), changed: z.boolean() })).optional(),
});

export const diffFileSchema = z.object({
  id: z.string(), path: z.string(), oldPath: z.string().optional(), lines: z.array(diffLineSchema),
  status: z.enum(['added', 'deleted', 'modified', 'renamed']).catch('modified'),
  omitted: z.enum(['binary', 'large']).optional(), previewOmitted: z.boolean().optional(),
  additions: z.coerce.number().catch(0), deletions: z.coerce.number().catch(0),
});

export const gitPatchSchema = z.union([
  z.string().transform(patch => ({ patch })),
  z.object({ patch: z.string() }),
]).catch({ patch: "" });
