import { z } from "zod";
import { rpcEventSchema, rpcCommandSchema } from "./rpcSchemas";
import { entrySchema } from "./chatSessionEventSchema";
import { gitDiffSnapshotSchema } from "./diffSchemas";

export { z, rpcEventSchema, rpcCommandSchema, entrySchema, gitDiffSnapshotSchema };

export const voidResultSchema = z.unknown().transform(() => undefined);

export const worktreeSetupScriptSchema = z.object({ id: z.string(), name: z.string(), script: z.string(), cleanupScript: z.string().optional(), enabled: z.boolean(), projectPath: z.string().optional(), hostId: z.string().optional() });

export const toolConfigSchema = z.object({ name: z.string(), description: z.string(), enabled: z.boolean(), builtin: z.boolean().optional() });

export const skillConfigSchema = z.object({ name: z.string(), path: z.string(), description: z.string(), enabled: z.boolean(), userInvokedOnly: z.boolean().optional() });

export const remoteHostSchema = z.object({ enabled: z.boolean().optional(), id: z.string(), name: z.string(), target: z.string(), piPath: z.string() });

export const appSettingsSchema = z.object({ reviewAgent: z.string().optional(), reviewPrompt: z.string().optional(), dictationModelPath: z.string().optional(), localEnabled: z.boolean().optional(), worktreeSetupScripts: z.array(worktreeSetupScriptSchema), defaultAgent: z.string().optional(), defaultModel: z.string(), hiddenModels: z.array(z.string()), knownModels: z.array(z.string()).optional(), defaultThinking: z.string(), defaultFastMode: z.boolean(), contextWindowCap: z.number(), contextWindowCapEnabled: z.boolean(), autoRetry: z.boolean(), debugMode: z.boolean(), keybindings: z.object({ newConversation: z.string(), toggleConversations: z.string(), toggleTerminal: z.string(), toggleDebugMode: z.string(), focusComposer: z.string(), openSettings: z.string() }), tools: z.array(toolConfigSchema), skills: z.array(skillConfigSchema), hosts: z.array(remoteHostSchema) });

export const clientSettingsSchema = appSettingsSchema.pick({ "keybindings": true, "hiddenModels": true, "knownModels": true, "debugMode": true });

export const agentConfigChangeSchema = z.object({ hostId: z.string(), revision: z.number() });

export const settingsChangeSchema = z.object({ settings: appSettingsSchema, agentConfigChange: agentConfigChangeSchema.optional() });

export const sessionSummarySchema = z.object({ id: z.string(), isDraft: z.boolean().optional(), subagentParentId: z.string().optional(), daemonId: z.string().optional(), isRunning: z.boolean().optional(), groupId: z.union([z.string(), z.null()]).optional(), path: z.string(), name: z.string(), project: z.string(), cwd: z.string(), cwdExists: z.boolean().optional(), projectRoot: z.union([z.string(), z.null()]).optional(), branch: z.union([z.string(), z.null()]).optional(), worktreeRoot: z.union([z.string(), z.null()]).optional(), branchAppearance: z.union([z.object({ letter: z.string().optional(), color: z.string().optional() }), z.null()]).optional(), projectKind: z.union([z.literal("no-repo"), z.literal("main"), z.literal("worktree"), z.null()]).optional(), preview: z.string(), messageCount: z.number(), lastMessageAt: z.number(), apiCost: z.number(), hostId: z.string().optional(), hostName: z.string().optional() });

export const sessionGroupSchema = z.object({ id: z.string(), name: z.string(), cwd: z.union([z.string(), z.null()]).optional(), hostId: z.union([z.string(), z.null()]).optional(), hostName: z.union([z.string(), z.null()]).optional(), projectKind: z.union([z.literal("no-repo"), z.literal("main"), z.literal("worktree"), z.null()]).optional(), branch: z.string().optional(), branchAppearance: sessionSummarySchema.shape["branchAppearance"].optional() });

export const sessionGroupsSchema = z.object({ groups: z.array(sessionGroupSchema), assignments: z.record(z.string(), z.union([z.string(), z.null()])), removedProjects: z.array(z.string()) });

export const projectBranchesSchema = z.object({ branches: z.array(z.string()), current: z.union([z.string(), z.null()]), path: z.string(), mainPath: z.string() });

export const storageCategorySchema = z.object({ id: z.union([z.literal("active-conversations"), z.literal("archived-conversations"), z.literal("project-checkpoints"), z.literal("git-diff-snapshots"), z.literal("temporary-chats")]), byteSize: z.number(), itemCount: z.number(), estimated: z.boolean().optional() });

export const archivedConversationSchema = z.object({ id: z.string(), path: z.string(), name: z.string(), cwd: z.string(), modifiedAt: z.number(), byteSize: z.number(), deletable: z.boolean(), deleteError: z.string().optional(), worktreePath: z.string().optional(), restorable: z.boolean().optional(), restoreError: z.string().optional() });

export const hostStorageSchema = z.object({ hostId: z.string(), hostName: z.string(), categories: z.array(storageCategorySchema), archives: z.array(archivedConversationSchema), warnings: z.array(z.string()), error: z.string().optional() });

export const storageReportSchema = z.object({ hosts: z.array(hostStorageSchema) });

export const gitWorktreeSchema = z.object({ branch: z.string(), path: z.string() });

export const gitWorktreeRemovalSchema = z.object({ branch: z.string().optional(), branchDeleted: z.boolean(), warning: z.string().optional() });

export const gitDiffSnapshotsSchema = z.record(z.string(), gitDiffSnapshotSchema);

export const codexUsageSchema = z.object({ remainingPercent: z.number(), resetAt: z.number().optional() });

export const usageWindowSchema = z.object({ status: z.string(), remainingPercent: z.number(), resetAt: z.number().optional() });

export const opencodeGoUsageSchema = z.object({ rolling: usageWindowSchema, weekly: usageWindowSchema, monthly: usageWindowSchema });

export const directoryListingSchema = z.object({ path: z.string(), parent: z.string().optional(), directories: z.array(z.string()) });

export const imageAttachmentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() });

export const pendingMessageSchema = z.object({ id: z.string(), message: z.string(), behavior: z.union([z.literal("steer"), z.literal("followUp")]), images: z.array(imageAttachmentSchema).optional(), retry: z.boolean().optional() });

export const modelSchema = z.object({ provider: z.string(), id: z.string(), name: z.string().optional(), reasoning: z.boolean().optional(), thinkingLevelMap: z.record(z.string(), z.json()).optional(), contextWindow: z.number().optional(), input: z.array(z.union([z.literal("text"), z.literal("image")])).optional() });

export const contextUsageSchema = z.object({ tokens: z.union([z.number(), z.null()]), contextWindow: z.number(), percent: z.union([z.number(), z.null()]) });

export const agentStateSchema = z.object({ viewers: z.number().optional(), pendingMessages: z.array(pendingMessageSchema).optional(), model: z.union([modelSchema, z.null()]), thinkingLevel: z.string(), isStreaming: z.boolean(), isCompacting: z.boolean().optional(), isPaused: z.boolean().optional(), isPausing: z.boolean().optional(), sessionFile: z.string().optional(), sessionId: z.string(), sessionName: z.string().optional(), messageCount: z.number(), pendingMessageCount: z.number(), activity: z.string().optional(), contextUsage: contextUsageSchema.optional() });

export const sessionSnapshotSchema = z.object({ revision: z.string(), state: agentStateSchema, history: z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]), omittedEntries: z.number().optional() }), sequence: z.number(), epoch: z.string(), liveTools: z.array(rpcEventSchema), queue: rpcEventSchema });

export const slashCommandSchema = z.object({ name: z.string(), description: z.string().optional(), source: z.union([z.literal("builtin"), z.literal("extension"), z.literal("prompt"), z.literal("skill")]), sourceInfo: z.object({ source: z.string().optional() }).optional() });

export const dictationConfigurationSchema = z.object({ enabled: z.boolean(), loading: z.boolean() });

export const authNoticeSchema = z.object({ type: z.union([z.literal("info"), z.literal("progress"), z.literal("auth_url"), z.literal("device_code")]), message: z.string().optional(), url: z.string().optional(), userCode: z.string().optional(), links: z.array(z.object({ url: z.string().optional(), label: z.string().optional() })).optional() });

export const authFlowSchema = z.object({ flowId: z.string(), providerId: z.string(), name: z.string().optional(), status: z.union([z.literal("pending"), z.literal("complete"), z.literal("cancelled"), z.literal("failed")]), notices: z.array(authNoticeSchema), error: z.string().optional(), prompt: z.object({ id: z.string(), type: z.union([z.literal("text"), z.literal("secret"), z.literal("select"), z.literal("manual_code")]), message: z.string(), placeholder: z.string().optional(), options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional() }).optional() });

export const providerAccountSchema = z.object({ id: z.string(), name: z.string(), providerId: z.string(), number: z.number(), configured: z.boolean(), source: z.string().optional(), storedType: z.union([z.literal("oauth"), z.literal("api_key")]).optional(), methods: z.array(z.object({ type: z.union([z.literal("oauth"), z.literal("api_key")]), name: z.string(), interactive: z.boolean() })) });

export const providerListingSchema = z.object({ providers: z.array(providerAccountSchema), warning: z.string().optional() });

export const projectDirectorySchema = z.object({ path: z.string(), parent: z.union([z.string(), z.null()]), entries: z.array(z.object({ name: z.string(), path: z.string(), directory: z.boolean() })) });

export const projectFileSchema = z.object({ path: z.string(), content: z.string(), revision: z.string() });
