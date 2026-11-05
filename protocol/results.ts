import { z } from "zod";

// What daemons answer to the commands of clients. The commands are in commands.ts.

export const sessionSummarySchema = z.object({
  id: z.string(), isDraft: z.boolean().optional(), auxiliaryParentId: z.string().optional(), auxiliaryKind: z.string().optional(),
  forkSourceId: z.string().optional(), forkEntryId: z.string().optional(), daemonId: z.string().optional(), isRunning: z.boolean().optional(),
  groupId: z.string().nullable().optional(), path: z.string(), name: z.string(), project: z.string(), cwd: z.string(), cwdExists: z.boolean().optional(),
  linkedWorktree: z.boolean().optional(), worktreeRepository: z.string().optional(), preview: z.string(), messageCount: z.number(), lastMessageAt: z.number(), apiCost: z.number(),
  hostId: z.string().optional(), hostName: z.string().optional(),
});
export type SessionSummary = z.output<typeof sessionSummarySchema>;

export const storageOwnershipSchema = z.enum(["owned", "referenced", "shared", "unattributed"]);

export const storageOwnerSchema = z.object({ sessionId: z.string(), sessionPath: z.string().optional(), kind: z.string() });

export const storageRootSchema = z.object({ path: z.string(), ownership: storageOwnershipSchema, provenance: z.array(z.string()), available: z.boolean(), owners: z.array(storageOwnerSchema), state: z.string().optional() });

export const storageCategorySchema = z.object({
  id: z.enum(["active-conversations", "archived-conversations", "temporary-chats", "chat-worktrees", "other-storage", "recovery-storage", "unattributed-recovery-storage", "goal-files"]),
  byteSize: z.number(), itemCount: z.number(), estimated: z.boolean().optional(), directories: z.array(z.string()).optional(), countUnit: z.string().optional(),
  ownership: storageOwnershipSchema.optional(), reclaimability: z.enum(["retained", "requires-owner-check", "unknown"]).optional(),
  measurement: z.enum(["allocated-blocks"]).optional(), includedInTotal: z.boolean().optional(), roots: z.array(storageRootSchema).optional(),
});

export const archivedConversationSchema = z.object({
  restorable: z.boolean().default(false), id: z.string(), path: z.string(), name: z.string(), cwd: z.string(), modifiedAt: z.number(), byteSize: z.number(),
  deletable: z.boolean(), deleteError: z.string().optional(), byteSizeCoverage: z.string().optional(),
});

export const hostStorageSchema = z.object({
  hostId: z.string(), hostName: z.string(), categories: z.array(storageCategorySchema), archives: z.array(archivedConversationSchema),
  warnings: z.array(z.string()), error: z.string().optional(),
});

export const storageReportSchema = z.object({ hosts: z.array(hostStorageSchema) });

export const codexUsageSchema = z.object({ remainingPercent: z.number(), resetAt: z.number().optional() });

export const usageWindowSchema = z.object({ status: z.string(), remainingPercent: z.number(), resetAt: z.number().optional() });

export const opencodeGoUsageSchema = z.object({ rolling: usageWindowSchema, weekly: usageWindowSchema, monthly: usageWindowSchema });

export const opencodexUsageSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), remainingPercent: z.number().optional(), resetAt: z.number().optional(), error: z.string().optional() })),
  unavailable: z.literal(true).optional(),
});

const providerUsage = <T extends z.ZodType>(usage: T) => z.object({ usage: usage.optional(), error: z.string().optional() }).optional();

export const providerUsageSchema = z.object({ codex: providerUsage(codexUsageSchema), anthropic: providerUsage(codexUsageSchema), opencodeGo: providerUsage(opencodeGoUsageSchema), opencodex: providerUsage(opencodexUsageSchema) });

export const directoryListingSchema = z.object({ path: z.string(), parent: z.string().nullable(), directories: z.array(z.string()) });
export type DirectoryListing = z.output<typeof directoryListingSchema>;

export const sharedTerminalsSchema = z.array(z.object({
  id: z.string(), output: z.string().nullable(), outputEnd: z.number(), inputDraft: z.string().optional(), generation: z.string(),
  owned: z.boolean(), started: z.boolean(), exited: z.boolean(),
}));

export const savedAgentsSchema = z.object({ revision: z.string(), warnings: z.array(z.string()) });

export const promptPreviewSchema = z.object({
  model: z.string(), messages: z.array(z.object({ role: z.string(), text: z.string() })),
  tools: z.array(z.object({ place: z.string(), json: z.string() })), notices: z.array(z.string()).optional(),
});
export type PromptPreview = z.output<typeof promptPreviewSchema>;

export const submissionOutcomeSchema = z.union([z.object({ accepted: z.literal(true) }), z.object({ accepted: z.literal(false), error: z.string() })]);

export const startedPiSchema = z.object({ attached: z.boolean(), owned: z.boolean().optional(), daemonId: z.string().optional(), cwd: z.string().nullable().optional() });
