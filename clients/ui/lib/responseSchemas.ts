import { pluginSettingsSchema } from "../plugins/settingsSchema";
import { z } from "zod";
import { rpcEventSchema, rpcCommandSchema } from "./rpcSchemas";
import { entrySchema, pendingMessageSchema } from "./chatSessionEventSchema";
import { usageSchema } from "./messageSchemas";

export { rpcEventSchema, rpcCommandSchema, entrySchema, pendingMessageSchema };

export const voidResultSchema = z.unknown().transform(() => undefined);

export const toolConfigSchema = z.object({ name: z.string(), description: z.string(), source: z.string() });

export const skillConfigSchema = z.object({ name: z.string(), path: z.string(), description: z.string(), enabled: z.boolean(), userInvokedOnly: z.boolean().optional() });

export const remoteHostSchema = z.object({ enabled: z.boolean().optional(), id: z.string(), name: z.string(), target: z.string(), piPath: z.string() });

export const appSettingsSchema = z.object({ settingsRevision: z.string().optional(), clientSettingsRevision: z.string().optional(), settingsDurabilityError: z.string().optional(), clientSettingsDurabilityError: z.string().optional(), localEnabled: z.boolean().optional(), ...pluginSettingsSchema.shape, modelAliases: z.record(z.string(), z.string()).optional(), hiddenModels: z.array(z.string()), knownModels: z.array(z.string()).optional(), defaultThinking: z.string(), defaultFastMode: z.boolean(), contextWindowCap: z.number(), contextWindowCapEnabled: z.boolean(), modelContextWindowCaps: z.record(z.string(), z.number().nullable()), autoRetry: z.boolean(), debugMode: z.boolean(), keybindings: z.object({ newConversation: z.string(), toggleConversations: z.string(), toggleTerminal: z.string(), toggleDebugMode: z.string(), focusComposer: z.string(), openSettings: z.string() }), tools: z.array(toolConfigSchema), skills: z.array(skillConfigSchema), hosts: z.array(remoteHostSchema) });

export const clientSettingsSchema = appSettingsSchema.pick({ "keybindings": true, "debugMode": true });

export const agentConfigChangeSchema = z.object({ hostId: z.string(), revision: z.number() });

export const settingsPublicationSchema = z.object({ committed: z.literal(true), durable: z.boolean(), error: z.string().optional() });

export const settingsChangeSchema = z.object({ settings: appSettingsSchema, publication: settingsPublicationSchema.optional(), agentConfigChange: agentConfigChangeSchema.optional(), committed: z.boolean().optional(), warnings: z.array(z.string()).optional(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), committedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), synchronizationPending: z.boolean().optional(), source: z.string().optional(), phaseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });

export const sessionSummarySchema = z.object({ id: z.string(), isDraft: z.boolean().optional(), subagentParentId: z.string().optional(), forkSourceId: z.string().optional(), daemonId: z.string().optional(), isRunning: z.boolean().optional(), groupId: z.union([z.string(), z.null()]).optional(), path: z.string(), name: z.string(), project: z.string(), cwd: z.string(), cwdExists: z.boolean().optional(), linkedWorktree: z.boolean().optional(), preview: z.string(), messageCount: z.number(), lastMessageAt: z.number(), apiCost: z.number(), hostId: z.string().optional(), hostName: z.string().optional() });

export const sessionGroupSchema = z.object({ id: z.string(), name: z.string(), cwd: z.union([z.string(), z.null()]).optional(), hostId: z.union([z.string(), z.null()]).optional(), hostName: z.union([z.string(), z.null()]).optional() });

export const sessionGroupsSchema = z.object({ groups: z.array(sessionGroupSchema), parents: z.record(z.string(), z.string()), assignments: z.record(z.string(), z.union([z.string(), z.null()])), removedProjects: z.array(z.string()) });

export const storageOwnershipSchema = z.enum(["owned", "referenced", "shared", "unattributed"]);

export const storageOwnerSchema = z.object({ sessionId: z.string(), sessionPath: z.string().optional(), kind: z.string() });

export const storageRootSchema = z.object({ path: z.string(), ownership: storageOwnershipSchema, provenance: z.array(z.string()), available: z.boolean(), owners: z.array(storageOwnerSchema), state: z.string().optional() });

export const storageCategorySchema = z.object({ id: z.enum(["active-conversations", "archived-conversations", "temporary-chats", "other-storage", "recovery-storage", "unattributed-recovery-storage", "goal-attachments", "unattributed-goal-attachments"]), byteSize: z.number(), itemCount: z.number(), estimated: z.boolean().optional(), directories: z.array(z.string()).optional(), countUnit: z.string().optional(), coverage: z.string().optional(), ownership: storageOwnershipSchema.optional(), reclaimability: z.enum(["retained", "requires-owner-check", "unknown"]).optional(), measurement: z.enum(["allocated-blocks"]).optional(), includedInTotal: z.boolean().optional(), roots: z.array(storageRootSchema).optional() });

export const archivedConversationSchema = z.object({ restorable: z.boolean().default(false), id: z.string(), path: z.string(), name: z.string(), cwd: z.string(), modifiedAt: z.number(), byteSize: z.number(), deletable: z.boolean(), deleteError: z.string().optional(), byteSizeCoverage: z.string().optional() });

export const hostStorageSchema = z.object({ hostId: z.string(), hostName: z.string(), categories: z.array(storageCategorySchema), archives: z.array(archivedConversationSchema), warnings: z.array(z.string()), error: z.string().optional() });

export const storageReportSchema = z.object({ hosts: z.array(hostStorageSchema) });

export const codexUsageSchema = z.object({ remainingPercent: z.number(), resetAt: z.number().optional() });

export const usageWindowSchema = z.object({ status: z.string(), remainingPercent: z.number(), resetAt: z.number().optional() });

export const opencodeGoUsageSchema = z.object({ rolling: usageWindowSchema, weekly: usageWindowSchema, monthly: usageWindowSchema });

export const directoryListingSchema = z.object({ path: z.string(), parent: z.string().optional(), directories: z.array(z.string()) });

export const imageAttachmentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() });

export const modelSchema = z.object({ provider: z.string(), id: z.string(), name: z.string().optional(), reasoning: z.boolean().optional(), thinkingLevelMap: z.record(z.string(), z.json()).optional(), contextWindow: z.number().optional(), input: z.array(z.union([z.literal("text"), z.literal("image")])).optional() });

export const contextUsageSchema = z.object({ tokens: z.union([z.number(), z.null()]), contextWindow: z.number(), percent: z.union([z.number(), z.null()]) });

export const gitRepositorySchema = z.object({ root: z.string().min(1), gitDir: z.string().min(1) });

export const forkSourceSchema = z.object({ sessionId: z.string().min(1), sessionPath: z.string().min(1), entryId: z.string().min(1) });

export const agentStateSchema = z.object({ canFork: z.boolean().optional(), viewers: z.number().optional(), pendingMessages: z.array(pendingMessageSchema).optional(), model: z.union([modelSchema, z.null()]), thinkingLevel: z.string(), isStreaming: z.boolean(), isCompacting: z.boolean().optional(), isPaused: z.boolean().optional(), isPausing: z.boolean().optional(), sessionFile: z.string().optional(), sessionId: z.string(), sessionName: z.string().optional(), cwd: z.string().optional(), repository: z.union([gitRepositorySchema, z.null()]).optional(), forkSource: forkSourceSchema.optional(), messageCount: z.number(), pendingMessageCount: z.number(), activity: z.string().optional(), contextUsage: contextUsageSchema.optional() });

export const forkAfterResultSchema = z.object({ cancelled: z.boolean().optional(), state: z.object({ cwd: z.union([z.string(), z.null()]).optional() }).optional() });

/** A part of a chat's history: before is the first entry left out of older history, if any. */
export const historyViewSchema = z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]), before: z.string().nullable().optional(), olderUsage: usageSchema.optional() });

export const sessionSnapshotSchema = z.object({ revision: z.string(), state: agentStateSchema, history: historyViewSchema.extend({ omittedEntries: z.number().optional(), incomplete: z.boolean().optional(), damagedLines: z.array(z.number().int().positive()).optional() }), sequence: z.number(), epoch: z.string(), liveTools: z.array(rpcEventSchema), queue: rpcEventSchema });

export const slashCommandSchema = z.object({ name: z.string(), description: z.string().optional(), source: z.union([z.literal("builtin"), z.literal("extension"), z.literal("prompt"), z.literal("skill")]), sourceInfo: z.object({ source: z.string().optional() }).optional(), options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional() });

export const authNoticeSchema = z.object({ type: z.union([z.literal("info"), z.literal("progress"), z.literal("auth_url"), z.literal("device_code")]), message: z.string().optional(), url: z.string().optional(), userCode: z.string().optional(), links: z.array(z.object({ url: z.string().optional(), label: z.string().optional() })).optional() });

export const authFlowSchema = z.object({ flowId: z.string(), providerId: z.string(), name: z.string().optional(), status: z.union([z.literal("pending"), z.literal("complete"), z.literal("cancelled"), z.literal("failed")]), notices: z.array(authNoticeSchema), error: z.string().optional(), prompt: z.object({ id: z.string(), type: z.union([z.literal("text"), z.literal("secret"), z.literal("select"), z.literal("manual_code")]), message: z.string(), placeholder: z.string().optional(), options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional() }).optional() });

export const providerAccountSchema = z.object({ id: z.string(), name: z.string(), configured: z.boolean(), source: z.string().optional(), storedType: z.union([z.literal("oauth"), z.literal("api_key")]).optional(), methods: z.array(z.object({ type: z.union([z.literal("oauth"), z.literal("api_key")]), name: z.string(), interactive: z.boolean() })) });

export const providerListingSchema = z.object({ providers: z.array(providerAccountSchema), warning: z.string().optional() });
