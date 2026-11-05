import type { AppSettings as HostSettings } from "../../protocol/settings";
import type { PluginMessage } from "../../protocol/plugins";

export type { ToolConfig, SkillConfig, RemoteHost } from "../../protocol/settings";
export type { DirectoryListing, SessionSummary } from "../../protocol/results";
import type { z } from "zod";
import type { rpcCommandSchema, rpcEventSchema } from "./lib/rpcSchemas";
import type { JSONType } from "zod";

export type ToolArguments = Record<string, JSONType>;

export type Role = "user" | "assistant" | "tool" | "system" | "custom";

export interface NestedToolCalls { calls: Array<{ id: string; name: string; arguments?: ToolArguments; argumentsBytes?: number; status: "ok" | "error" | "unfinished"; durationMs?: number; error?: string }>; complete: boolean; }

export interface ChatMessage { nestedCalls?: NestedToolCalls; }

export type ContentPart = ImageAttachment | { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: ToolArguments; partialArgs?: string };

export interface ChatMessage { deliveryBehavior?: "steer" | "followUp"; id: string; entryId?: string; role: Role; content: string | ContentPart[]; customType?: string; timestamp?: number; startedAt?: number; completedAt?: number; model?: string; streaming?: boolean; stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"; errorMessage?: string; toolName?: string; toolInput?: unknown; toolStatus?: "running" | "done" | "error"; promptContext?: PromptContextInfo; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }; }

export type StorageOwnership = "owned" | "referenced" | "shared" | "unattributed";

export interface StorageOwner { sessionId: string; sessionPath?: string; kind: string; }

export interface StorageRoot { path: string; ownership: StorageOwnership; provenance: string[]; available: boolean; owners: StorageOwner[]; state?: string; }

export interface StorageCategory { id: "active-conversations" | "archived-conversations" | "temporary-chats" | "chat-worktrees" | "other-storage" | "recovery-storage" | "unattributed-recovery-storage" | "goal-files"; byteSize: number; itemCount: number; estimated?: boolean; directories?: string[]; countUnit?: string; ownership?: StorageOwnership; reclaimability?: "retained" | "requires-owner-check" | "unknown"; measurement?: "allocated-blocks"; includedInTotal?: boolean; roots?: StorageRoot[]; }

export interface ArchivedConversation { restorable: boolean; id: string; path: string; name: string; cwd: string; modifiedAt: number; byteSize: number; deletable: boolean; deleteError?: string; byteSizeCoverage?: string; }

export interface HostStorage { hostId: string; hostName: string; categories: StorageCategory[]; archives: ArchivedConversation[]; warnings: string[]; error?: string; }

export interface StorageReport { hosts: HostStorage[]; }

export interface ChatMessage { contextUserTimestamp?: number; }

export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; }

export interface PromptContextInfo {
  inputTokens?: number;
  userTimestamp?: number;
  systemPrompt: string;
  instructions: Array<{ path: string; content: string }>;
  tools: Array<{ name: string; description: string; parameters?: unknown; codemode?: boolean; deferred?: true }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
  userInvokedSkills?: Array<{ id?: string; name: string; description: string; filePath: string; content?: string }>;
  skillTokens?: { defined: number; invoked: number };
  tokens: { system: number; instructions: number; tools: number; skills: number };
}

export interface PendingMessage { id: string; goalSubmissionId?: string; message: string; behavior: "steer" | "followUp"; images?: (Omit<ImageAttachment, "data"> & { data?: string; id?: string })[]; retry?: boolean; recovered?: boolean; sending?: boolean; goal?: boolean; }

export interface GitRepository { root: string; gitDir: string; }

export interface ForkSource { sessionId: string; sessionPath: string; entryId: string; }

export interface AgentState { canFork?: boolean; viewers?: number; pendingMessages?: PendingMessage[]; queueHeld?: boolean; model: Model | null; thinkingLevel: string; isStreaming: boolean; isCompacting?: boolean; sessionFile?: string; sessionId: string; sessionName?: string; cwd?: string; repository?: GitRepository | null; forkSource?: ForkSource; messageCount: number; pendingMessageCount: number; activity?: string; contextUsage?: ContextUsage; }

export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; error?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }

export interface ExtensionUiResponse { cancelled?: boolean; confirmed?: boolean; value?: string; }

export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, JSONType>; contextWindow?: number; input?: ("text" | "image")[]; }

export type AgentAccess = "all" | "none" | string[];
export interface AgentProfile { unavailableReason?: string; project?: boolean; name: string; description?: string; isDefault?: boolean; model: string; effort: string; fastMode?: boolean; contextWindowCap?: number | null; codemode?: "on" | "off"; extensions?: string[]; max_subagents?: number; allow_as_subagent?: boolean; allow_as_peer?: boolean; allowed_subagents?: AgentAccess; allowed_peers?: AgentAccess; path_systemprompt: string; path_agent_prompt: string; tools: string[]; skills: string[]; mcpServers: McpServers; }

export interface ProjectAgents { directory: string; revision: string; defaultAgent?: string; }

export interface AgentConfig { revision?: string; project?: ProjectAgents; agents: AgentProfile[]; }

export interface DefinedAgentsCapability { version: number; active: string; saved?: boolean; unavailable?: boolean; config: AgentConfig; }


export interface SettingsPublication { committed: true; durable: boolean; error?: string; }

export interface SettingsChange { settings: AppSettings; publication?: SettingsPublication; committed?: boolean; warnings?: string[]; revision?: number; committedRevision?: number; synchronizationPending?: boolean; source?: string; phaseRevision?: number; }

export type RpcCommand = z.infer<typeof rpcCommandSchema>;

export type RpcEvent = z.infer<typeof rpcEventSchema>;

export type McpServers = import("zod").infer<typeof import("./lib/agentSchemas").mcpServersSchema>;


export interface CommandOption { value: string; label: string; description?: string; }
export interface SlashCommand { name: string; description?: string; source: "builtin" | "extension" | "prompt" | "skill"; sourceInfo?: { source?: string }; options?: CommandOption[]; }

export interface ImageAttachment { type: "image"; data: string; mimeType: string; name?: string; }

export interface ComposerUpload { id: string; name: string; kind: "image" | "text"; byteSize: number; image?: ImageAttachment; text?: string; }

// The settings of a host, and what the client adds to them: the client preferences of this app and the save states.
export type AppSettings = HostSettings & { clientSettingsRevision?: string; settingsDurabilityError?: string; clientSettingsDurabilityError?: string; debugFeaturesOff?: string[] };

export { USAGE_INDICATORS, type UsageIndicator } from "../../protocol/settings";

export interface CodexUsage { remainingPercent: number; resetAt?: number; }

export interface UsageWindow { status: string; remainingPercent: number; resetAt?: number; }

export interface OpencodeGoUsage { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow; }

export interface OpencodexUsage { accounts: Array<{ id: string; remainingPercent?: number; resetAt?: number; error?: string }>; unavailable?: true; }

export interface ChatMessage { toolCallId?: string; details?: unknown; subagents?: unknown; }

export interface ChatMessage { deferredToolPayload?: string; toolPayloadLoaded?: boolean; toolImage?: boolean; toolPayloadEvicted?: boolean; toolPayloadVersion?: number; loadedToolPayloadVersion?: number; loadToolPayload?: () => Promise<void>; }

export interface ChatMessage { submissionId?: string; piopQueueId?: string; piopSubmissionId?: string; }

// How to show a plugin's custom message. Its host adds it from the plugin's manifest.
export interface ChatMessage { pluginMessage?: PluginMessage; }

export interface ChatMessage { deferredWork?: { reasoningOnly: boolean; usage?: ChatMessage["usage"]; firstUsage?: ChatMessage["usage"] }; loadWork?: () => Promise<void>; }

export type PendingMessageAction = "steer" | "followUp" | "remove" | "moveUp" | "moveDown" | { type: "move"; targetId: string; edge: "before" | "after" } | { type: "edit"; message: string; images: { keep: number[]; add: ImageAttachment[] } };
