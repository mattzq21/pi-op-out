import { z } from "zod";
import { appSettingsSchema } from "../../../protocol/settings";
import { rpcEventSchema, rpcCommandSchema } from "./rpcSchemas";
import { entrySchema, pendingMessageSchema } from "./chatSessionEventSchema";
import { usageSchema } from "./messageSchemas";

export { rpcEventSchema, rpcCommandSchema, entrySchema, pendingMessageSchema };

export { toolConfigSchema, skillConfigSchema, remoteHostSchema, appSettingsSchema, settingsPublicationSchema, settingsChangeSchema } from "../../../protocol/settings";
export { sessionGroupSchema, sessionGroupOrdersSchema, sessionGroupsSchema } from "../../../protocol/session-groups";
export {
  sessionSummarySchema, storageOwnershipSchema, storageOwnerSchema, storageRootSchema, storageCategorySchema, archivedConversationSchema, hostStorageSchema,
  storageReportSchema, codexUsageSchema, usageWindowSchema, opencodeGoUsageSchema, opencodexUsageSchema, providerUsageSchema, directoryListingSchema,
} from "../../../protocol/results";

// The client preferences that the daemon keeps with its settings.
export const clientSettingsSchema = appSettingsSchema.pick({ keybindings: true, debugMode: true });

export const voidResultSchema = z.unknown().transform(() => undefined);

export const imageAttachmentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() });

export const modelSchema = z.object({ provider: z.string(), id: z.string(), name: z.string().optional(), reasoning: z.boolean().optional(), thinkingLevelMap: z.record(z.string(), z.json()).optional(), contextWindow: z.number().optional(), input: z.array(z.union([z.literal("text"), z.literal("image")])).optional() });

export const contextUsageSchema = z.object({ tokens: z.union([z.number(), z.null()]), contextWindow: z.number(), percent: z.union([z.number(), z.null()]) });

export const gitRepositorySchema = z.object({ root: z.string().min(1), gitDir: z.string().min(1) });

export const forkSourceSchema = z.object({ sessionId: z.string().min(1), sessionPath: z.string().min(1), entryId: z.string().min(1) });

export const agentStateSchema = z.object({ canFork: z.boolean().optional(), viewers: z.number().optional(), pendingMessages: z.array(pendingMessageSchema).optional(), queueHeld: z.boolean().optional(), model: z.union([modelSchema, z.null()]), thinkingLevel: z.string(), isStreaming: z.boolean(), isCompacting: z.boolean().optional(), sessionFile: z.string().optional(), sessionId: z.string(), sessionName: z.string().optional(), cwd: z.string().optional(), repository: z.union([gitRepositorySchema, z.null()]).optional(), forkSource: forkSourceSchema.optional(), messageCount: z.number(), pendingMessageCount: z.number(), activity: z.string().optional(), contextUsage: contextUsageSchema.optional() });

export const forkAfterResultSchema = z.object({ cancelled: z.boolean().optional(), state: z.object({ cwd: z.union([z.string(), z.null()]).optional() }).optional() });

export const historyOutlineSchema = z.object({ responses: z.array(z.object({ id: z.string().min(1), start: z.string().min(1), preview: z.string(), compactions: z.array(z.string().min(1)).optional() })) });

export const historyViewSchema = z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]), before: z.string().nullable().optional(), olderUsage: usageSchema.optional() });

export const sessionSnapshotSchema = z.object({ revision: z.string(), state: agentStateSchema, history: historyViewSchema.extend({ outline: historyOutlineSchema.shape.responses.optional(), omittedEntries: z.number().optional(), incomplete: z.boolean().optional(), damagedLines: z.array(z.number().int().positive()).optional() }), sequence: z.number(), epoch: z.string(), liveTools: z.array(rpcEventSchema), queue: rpcEventSchema });

export const slashCommandSchema = z.object({ name: z.string(), description: z.string().optional(), source: z.union([z.literal("builtin"), z.literal("extension"), z.literal("prompt"), z.literal("skill")]), sourceInfo: z.object({ source: z.string().optional() }).optional(), options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional() });

export const authNoticeSchema = z.object({ type: z.union([z.literal("info"), z.literal("progress"), z.literal("auth_url"), z.literal("device_code")]), message: z.string().optional(), url: z.string().optional(), userCode: z.string().optional(), links: z.array(z.object({ url: z.string().optional(), label: z.string().optional() })).optional() });

export const authFlowSchema = z.object({ flowId: z.string(), providerId: z.string(), name: z.string().optional(), status: z.union([z.literal("pending"), z.literal("complete"), z.literal("cancelled"), z.literal("failed")]), notices: z.array(authNoticeSchema), error: z.string().optional(), prompt: z.object({ id: z.string(), type: z.union([z.literal("text"), z.literal("secret"), z.literal("select"), z.literal("manual_code")]), message: z.string(), placeholder: z.string().optional(), options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional() }).optional() });

export const providerAccountSchema = z.object({ id: z.string(), name: z.string(), configured: z.boolean(), source: z.string().optional(), storedType: z.union([z.literal("oauth"), z.literal("api_key")]).optional(), custom: z.boolean().optional(), methods: z.array(z.object({ type: z.union([z.literal("oauth"), z.literal("api_key")]), name: z.string(), interactive: z.boolean() })) });

export const providerListingSchema = z.object({ providers: z.array(providerAccountSchema), warning: z.string().optional() });
