import { Type, type Static } from "typebox";

export const fileErrorSchema = Type.Object({ code: Type.String() });

export const sessionHeaderSchema = Type.Object({ type: Type.Literal("session"), id: Type.String() });

export const commitSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });

export const copiedSnapshotSchema = Type.Object({ repositoryRoot: Type.String(), commit: Type.String({ pattern: "^[a-fA-F0-9]{40,64}$" }) });

export const checkpointSchema = Type.Object({
  repositoryRoot: Type.Optional(Type.String()), key: Type.String({ pattern: "^[a-zA-Z0-9-]+$" }),
  owner: Type.String(), commit: commitSchema, base: Type.Union([Type.Null(), commitSchema]), capturedAt: Type.Optional(Type.String()),
});

export const responseIdsSchema = Type.Object({ responseEntryIds: Type.Array(Type.String()) });

export const responseCommitSchema = Type.Object({ commit: commitSchema });

export const resumeSchema = Type.Object({ message: Type.String() });

export const branchRequestSchema = Type.Object({ id: Type.String(), entryId: Type.String(), name: Type.String(), afterResponse: Type.Optional(Type.Unknown()) });

export const requestIdSchema = Type.Object({ id: Type.String() });
export const rollbackRequestSchema = Type.Object({ id: Type.String(), entryId: Type.String() });

export const queuedContextSchema = Type.Object({ timestamp: Type.Number(), content: Type.String() });

export type PromptCheckpoint = Static<typeof checkpointSchema>;
