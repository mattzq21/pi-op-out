import type { z } from "zod";
import type { rpcCommandSchema, rpcEventSchema } from "./lib/rpcSchemas";
import type { JSONType } from "zod";

export type ToolArguments = Record<string, JSONType>;

export type Role = "user" | "assistant" | "tool" | "system" | "custom";

export interface NestedToolCalls { calls: Array<{ id: string; name: string; arguments?: ToolArguments; argumentsBytes?: number; status: "ok" | "error" | "unfinished"; durationMs?: number; error?: string }>; complete: boolean; }

export interface ChatMessage { nestedCalls?: NestedToolCalls; }

export type ContentPart = ImageAttachment | { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: ToolArguments; partialArgs?: string };

export interface ChatMessage { deliveryBehavior?: "steer" | "followUp"; id: string; entryId?: string; role: Role; content: string | ContentPart[]; customType?: string; timestamp?: number; completedAt?: number; model?: string; streaming?: boolean; stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"; errorMessage?: string; toolName?: string; toolInput?: unknown; toolStatus?: "running" | "done" | "error"; promptContext?: PromptContextInfo; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }; }

export interface SessionSummary { id: string; isDraft?: boolean; subagentParentId?: string; daemonId?: string; isRunning?: boolean; groupId?: string | null; path: string; name: string; project: string; cwd: string; cwdExists?: boolean; preview: string; messageCount: number; lastMessageAt: number; apiCost: number; hostId?: string; hostName?: string; }

export type StorageOwnership = "owned" | "referenced" | "shared" | "unattributed";

export interface StorageOwner { sessionId: string; sessionPath?: string; kind: string; }

export interface StorageRoot { path: string; ownership: StorageOwnership; provenance: string[]; available: boolean; owners: StorageOwner[]; state?: string; }

export interface StorageCategory { id: "active-conversations" | "archived-conversations" | "temporary-chats" | "other-storage" | "recovery-storage" | "unattributed-recovery-storage" | "chatgpt-storage" | "goal-attachments" | "unattributed-goal-attachments"; byteSize: number; itemCount: number; estimated?: boolean; directories?: string[]; countUnit?: string; coverage?: string; ownership?: StorageOwnership; reclaimability?: "retained" | "requires-owner-check" | "unknown"; measurement?: "allocated-blocks"; includedInTotal?: boolean; roots?: StorageRoot[]; }

export interface ArchivedConversation { id: string; path: string; name: string; cwd: string; modifiedAt: number; byteSize: number; deletable: boolean; deleteError?: string; byteSizeCoverage?: string; }

export interface HostStorage { hostId: string; hostName: string; categories: StorageCategory[]; archives: ArchivedConversation[]; warnings: string[]; error?: string; }

export interface StorageReport { hosts: HostStorage[]; }

export interface ChatMessage { contextCheckpoint?: boolean; contextUserTimestamp?: number; }

export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; }

export interface PromptContextInfo {
  inputTokens?: number;
  userTimestamp?: number;
  systemPrompt: string;
  instructions: Array<{ path: string; content: string }>;
  tools: Array<{ name: string; description: string; parameters?: unknown }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
  userInvokedSkills?: Array<{ id?: string; name: string; description: string; filePath: string; content?: string }>;
  skillTokens?: { defined: number; invoked: number };
  tokens: { system: number; instructions: number; tools: number; skills: number };
}

export interface PendingMessage { id: string; message: string; behavior: "steer" | "followUp"; images?: Omit<ImageAttachment, "data">[]; retry?: boolean; recovered?: boolean; }

export interface AgentState { viewers?: number; pendingMessages?: PendingMessage[]; model: Model | null; thinkingLevel: string; isStreaming: boolean; isCompacting?: boolean; isPaused?: boolean; isPausing?: boolean; sessionFile?: string; sessionId: string; sessionName?: string; messageCount: number; pendingMessageCount: number; activity?: string; contextUsage?: ContextUsage; }

export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; error?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }

export interface ExtensionUiResponse { cancelled?: boolean; confirmed?: boolean; value?: string; }

export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, JSONType>; contextWindow?: number; input?: ("text" | "image")[]; }

export interface AgentProfile { name: string; model: string; effort: string; fastMode?: boolean; codemode?: boolean; extensions?: string[]; max_subagents?: number; max_sub_subagents?: number; path_systemprompt: string; path_agent_prompt: string; tools: string[]; skills: string[]; mcpServers: McpServers; }

export interface AgentConfig { revision?: string; agents: AgentProfile[]; fastModeModels?: string[]; }

export interface DefinedAgentsCapability { version: number; active: string; locked?: boolean; saved?: boolean; unavailable?: boolean; config: AgentConfig; }

export interface AgentConfigChange { hostId: string; revision: number; }

export interface SettingsPublication { committed: true; durable: boolean; error?: string; }

export interface SettingsChange { settings: AppSettings; publication?: SettingsPublication; agentConfigChange?: AgentConfigChange; committed?: boolean; warnings?: string[]; revision?: number; committedRevision?: number; synchronizationPending?: boolean; source?: string; phaseRevision?: number; }

export type RpcCommand = z.infer<typeof rpcCommandSchema>;

export type RpcEvent = z.infer<typeof rpcEventSchema>;

export interface ToolConfig { name: string; description: string; enabled: boolean; builtin?: boolean; }

export interface SkillConfig { name: string; path: string; description: string; enabled: boolean; userInvokedOnly?: boolean; }

export type McpServers = import("zod").infer<typeof import("./lib/agentSchemas").mcpServersSchema>;

export interface RemoteHost { enabled?: boolean; id: string; name: string; target: string; piPath: string; }

export interface DirectoryListing { path: string; parent?: string; directories: string[]; }

export interface SlashCommand { name: string; description?: string; source: "builtin" | "extension" | "prompt" | "skill"; sourceInfo?: { source?: string }; }

export interface ImageAttachment { type: "image"; data: string; mimeType: string; name?: string; }

export interface ComposerUpload { id: string; name: string; kind: "image" | "text"; byteSize: number; image?: ImageAttachment; text?: string; }

 /** The speech-to-text program the daemon runs: transcribe.cpp or Cactus Needle. */
 export type DictationEngine = "transcribe.cpp" | "needle";
 export interface AppSettings { settingsRevision?: string; clientSettingsRevision?: string; settingsDurabilityError?: string; clientSettingsDurabilityError?: string; dictationEngine?: DictationEngine; dictationEnginePath?: string; dictationModelPath?: string; localEnabled?: boolean; defaultAgent?: string; reviewAgent?: string; reviewPrompt?: string; defaultModel: string; hiddenModels: string[]; knownModels?: string[]; defaultThinking: string; defaultFastMode: boolean; contextWindowCap: number; contextWindowCapEnabled: boolean; autoRetry: boolean; debugMode: boolean; keybindings: import("./lib/keybindings").Keybindings; tools: ToolConfig[]; skills: SkillConfig[]; hosts: RemoteHost[]; }

export interface CodexUsage { remainingPercent: number; resetAt?: number; }

export interface UsageWindow { status: string; remainingPercent: number; resetAt?: number; }

export interface OpencodeGoUsage { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow; }

export interface ChatMessage { toolCallId?: string; details?: unknown; }

export interface ChatMessage { deferredToolPayload?: string; toolPayloadLoaded?: boolean; toolPayloadVersion?: number; loadedToolPayloadVersion?: number; loadToolPayload?: () => Promise<void>; }

export interface ChatMessage { submissionId?: string; }

export type PendingMessageAction = "steer" | "followUp" | "remove" | "moveUp" | "moveDown" | { type: "move"; targetId: string; edge: "before" | "after" };
