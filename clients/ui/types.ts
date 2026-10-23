import type { PluginSettings } from "./plugins/settingsSchema";
import type { z } from "zod";
import type { rpcCommandSchema, rpcEventSchema } from "./lib/rpcSchemas";
import type { JSONType } from "zod";

export type ToolArguments = Record<string, JSONType>;

export type Role = "user" | "assistant" | "tool" | "system" | "custom";

export interface NestedToolCalls { calls: Array<{ id: string; name: string; arguments?: ToolArguments; argumentsBytes?: number; status: "ok" | "error" | "unfinished"; durationMs?: number; error?: string }>; complete: boolean; }

export interface ChatMessage { nestedCalls?: NestedToolCalls; }

export type ContentPart = ImageAttachment | { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: ToolArguments; partialArgs?: string };

export interface ChatMessage { deliveryBehavior?: "steer" | "followUp"; id: string; entryId?: string; role: Role; content: string | ContentPart[]; customType?: string; timestamp?: number; completedAt?: number; model?: string; streaming?: boolean; stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"; errorMessage?: string; toolName?: string; toolInput?: unknown; toolStatus?: "running" | "done" | "error"; promptContext?: PromptContextInfo; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }; }

export interface SessionSummary { id: string; isDraft?: boolean; subagentParentId?: string; forkSourceId?: string; daemonId?: string; isRunning?: boolean; groupId?: string | null; path: string; name: string; project: string; cwd: string; cwdExists?: boolean; linkedWorktree?: boolean; preview: string; messageCount: number; lastMessageAt: number; apiCost: number; hostId?: string; hostName?: string; }

export type StorageOwnership = "owned" | "referenced" | "shared" | "unattributed";

export interface StorageOwner { sessionId: string; sessionPath?: string; kind: string; }

export interface StorageRoot { path: string; ownership: StorageOwnership; provenance: string[]; available: boolean; owners: StorageOwner[]; state?: string; }

export interface StorageCategory { id: "active-conversations" | "archived-conversations" | "temporary-chats" | "other-storage" | "recovery-storage" | "unattributed-recovery-storage" | "goal-attachments" | "unattributed-goal-attachments"; byteSize: number; itemCount: number; estimated?: boolean; directories?: string[]; countUnit?: string; coverage?: string; ownership?: StorageOwnership; reclaimability?: "retained" | "requires-owner-check" | "unknown"; measurement?: "allocated-blocks"; includedInTotal?: boolean; roots?: StorageRoot[]; }

export interface ArchivedConversation { restorable: boolean; id: string; path: string; name: string; cwd: string; modifiedAt: number; byteSize: number; deletable: boolean; deleteError?: string; byteSizeCoverage?: string; }

export interface HostStorage { hostId: string; hostName: string; categories: StorageCategory[]; archives: ArchivedConversation[]; warnings: string[]; error?: string; }

export interface StorageReport { hosts: HostStorage[]; }

export interface ChatMessage { contextCheckpoint?: boolean; contextUserTimestamp?: number; }

export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; }

export interface PromptContextInfo {
  inputTokens?: number;
  userTimestamp?: number;
  systemPrompt: string;
  instructions: Array<{ path: string; content: string }>;
  /** codemode: whether codemode scripts can call the tool. Present only while codemode is active. */
  tools: Array<{ name: string; description: string; parameters?: unknown; codemode?: boolean }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
  userInvokedSkills?: Array<{ id?: string; name: string; description: string; filePath: string; content?: string }>;
  skillTokens?: { defined: number; invoked: number };
  tokens: { system: number; instructions: number; tools: number; skills: number };
}

/** sending: the message was sent, but the daemon has not queued it yet. It cannot be changed yet. */
export interface PendingMessage { id: string; message: string; behavior: "steer" | "followUp"; images?: (Omit<ImageAttachment, "data"> & { data?: string })[]; retry?: boolean; recovered?: boolean; sending?: boolean; }

export interface GitRepository { root: string; gitDir: string; }

export interface ForkSource { sessionId: string; sessionPath: string; entryId: string; }

export interface AgentState { canFork?: boolean; viewers?: number; pendingMessages?: PendingMessage[]; model: Model | null; thinkingLevel: string; isStreaming: boolean; isCompacting?: boolean; isPaused?: boolean; isPausing?: boolean; sessionFile?: string; sessionId: string; sessionName?: string; cwd?: string; repository?: GitRepository | null; forkSource?: ForkSource; messageCount: number; pendingMessageCount: number; activity?: string; contextUsage?: ContextUsage; }

export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; error?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }

export interface ExtensionUiResponse { cancelled?: boolean; confirmed?: boolean; value?: string; }

export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, JSONType>; contextWindow?: number; input?: ("text" | "image")[]; }

/** Which agents an agent may start: all of them, none, or the named ones. Missing means all. */
export type AgentAccess = "all" | "none" | string[];
export interface AgentProfile { name: string; description?: string; isDefault?: boolean; model: string; effort: string; fastMode?: boolean; contextWindowCap?: number | null; codemode?: "on" | "off"; extensions?: string[]; max_subagents?: number; max_sub_subagents?: number; allow_as_subagent?: boolean; allow_as_peer?: boolean; allowed_subagents?: AgentAccess; allowed_peers?: AgentAccess; path_systemprompt: string; path_agent_prompt: string; tools: string[]; skills: string[]; mcpServers: McpServers; }

export interface AgentConfig { revision?: string; agents: AgentProfile[]; }

export interface DefinedAgentsCapability { version: number; active: string; locked?: boolean; saved?: boolean; unavailable?: boolean; config: AgentConfig; }

export interface AgentConfigChange { hostId: string; revision: number; }

export interface SettingsPublication { committed: true; durable: boolean; error?: string; }

export interface SettingsChange { settings: AppSettings; publication?: SettingsPublication; agentConfigChange?: AgentConfigChange; committed?: boolean; warnings?: string[]; revision?: number; committedRevision?: number; synchronizationPending?: boolean; source?: string; phaseRevision?: number; }

export type RpcCommand = z.infer<typeof rpcCommandSchema>;

export type RpcEvent = z.infer<typeof rpcEventSchema>;

/** A tool that Pi offers on a host. source is the path of the extension that registered it, or builtin:<name> for a Pi built-in. */
export interface ToolConfig { name: string; description: string; source: string; }

export interface SkillConfig { name: string; path: string; description: string; enabled: boolean; userInvokedOnly?: boolean; }

export type McpServers = import("zod").infer<typeof import("./lib/agentSchemas").mcpServersSchema>;

export interface RemoteHost { enabled?: boolean; id: string; name: string; target: string; piPath: string; }

export interface DirectoryListing { path: string; parent?: string; directories: string[]; }

/** An argument choice of a slash command. An empty value is a hint that describes a free argument. */
export interface CommandOption { value: string; label: string; description?: string; }
export interface SlashCommand { name: string; description?: string; source: "builtin" | "extension" | "prompt" | "skill"; sourceInfo?: { source?: string }; options?: CommandOption[]; }

export interface ImageAttachment { type: "image"; data: string; mimeType: string; name?: string; }

export interface ComposerUpload { id: string; name: string; kind: "image" | "text"; byteSize: number; image?: ImageAttachment; text?: string; }

 export interface AppSettings extends PluginSettings { settingsRevision?: string; clientSettingsRevision?: string; settingsDurabilityError?: string; clientSettingsDurabilityError?: string; localEnabled?: boolean; modelAliases?: Record<string, string>; hiddenModels: string[]; knownModels?: string[]; defaultThinking: string; defaultFastMode: boolean; contextWindowCap: number; contextWindowCapEnabled: boolean; modelContextWindowCaps: Record<string, number | null>; autoRetry: boolean; debugMode: boolean; debugFeaturesOff?: string[]; keybindings: import("./lib/keybindings").Keybindings; tools: ToolConfig[]; skills: SkillConfig[]; hosts: RemoteHost[]; }

export interface CodexUsage { remainingPercent: number; resetAt?: number; }

export interface UsageWindow { status: string; remainingPercent: number; resetAt?: number; }

export interface OpencodeGoUsage { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow; }

export interface ChatMessage { toolCallId?: string; details?: unknown; }

export interface ChatMessage { deferredToolPayload?: string; toolPayloadLoaded?: boolean; /** The memory limit removed the loaded tool payload. It loads again only on request. */ toolPayloadEvicted?: boolean; toolPayloadVersion?: number; loadedToolPayloadVersion?: number; loadToolPayload?: () => Promise<void>; }

export interface ChatMessage { submissionId?: string; piopQueueId?: string; piopSubmissionId?: string; }

/** The daemon left out the work of this finished turn. loadWork fetches it. */
export interface ChatMessage { deferredWork?: { reasoningOnly: boolean; usage?: ChatMessage["usage"]; firstUsage?: ChatMessage["usage"] }; loadWork?: () => Promise<void>; }

export type PendingMessageAction = "steer" | "followUp" | "remove" | "moveUp" | "moveDown" | { type: "move"; targetId: string; edge: "before" | "after" };
