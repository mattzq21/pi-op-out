import { z } from "zod";
import { nativeCall } from "./nativeCall";

const recoveredSchema = z.object({ headCommit: z.string().nullable(), branch: z.string().nullable() });

const recoverySchema = z.object({ mode: z.enum(["empty", "remote-branch", "legacy-copy"]), recovered: recoveredSchema });

const retainedSchema = z.object({ directory: z.string(), state: z.enum(["allocated", "ready", "published"]), mode: z.enum(["empty", "remote-branch", "legacy-copy"]) });

const inspectionSchema = z.object({
  canRecoverRemote: z.boolean(), cwd: z.string(), managedRoot: z.string(),
  legacyRecovery: z.enum(["available", "missing"]).nullable(), stagedDirectory: z.string().nullable(), currentRecovery: recoverySchema.nullable(),
  retainedDirectories: z.array(retainedSchema),
});

const resultSchema = z.object({
  cwd: z.string(), recovery: recoverySchema,
  warnings: z.array(z.string()),
});

const discoverySchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string(), sessionPath: z.string(), cwd: z.string(), exists: z.boolean(), stagedDirectory: z.string().nullable(), retainedDirectories: z.array(retainedSchema) })),
  warnings: z.array(z.string()),
});

export type RecoveryInspection = z.infer<typeof inspectionSchema>;

export type RecoveredDirectory = z.infer<typeof resultSchema>;

export function isTemporaryRecoveryDirectory(cwd: string) {
  return /^\/tmp\/(?:piop-session-[a-zA-Z0-9]{6}|piop-recovery-[a-zA-Z0-9]{6}\/workdir)$/.test(cwd);
}

export const inspectRecoveryDirectory = (sessionPath: string, hostId = "local") => nativeCall("recover_missing_session", { sessionPath, hostId, action: "inspect" }, inspectionSchema);

export const discoverRecoveryDirectories = (hostId = "local") => nativeCall("recover_missing_session", { sessionPath: "", hostId, action: "discover" }, discoverySchema);

export const migrateRecoveryDirectory = (sessionPath: string, hostId = "local") => nativeCall("recover_missing_session", { sessionPath, hostId, action: "migrate" }, resultSchema);

export const recoverSessionDirectory = (sessionPath: string, action: "remote" | "empty", repository: string, branch: string, hostId = "local") => nativeCall("recover_missing_session", { sessionPath, hostId, action, repository, branch }, z.union([resultSchema, z.object({ missingFields: z.array(z.string()) })]));
