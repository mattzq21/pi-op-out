export type Role = "user" | "assistant" | "tool" | "system";
export type ContentPart = ImageAttachment | { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; partialArgs?: string };
export interface ChatMessage { deliveryBehavior?: "steer" | "followUp"; id: string; entryId?: string; role: Role; content: string | ContentPart[]; customType?: string; timestamp?: number; completedAt?: number; model?: string; streaming?: boolean; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string; toolName?: string; toolInput?: unknown; toolStatus?: "running" | "done" | "error"; promptContext?: PromptContextInfo; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }; }
export interface SessionSummary { id: string; isDraft?: boolean; subagentParentId?: string; daemonId?: string; isRunning?: boolean; groupId?: string | null; path: string; name: string; project: string; cwd: string; cwdExists?: boolean; projectRoot?: string | null; projectKind?: "no-repo" | "main" | "worktree" | null; preview: string; messageCount: number; lastMessageAt: number; apiCost: number; hostId?: string; hostName?: string; }
export interface StorageCategory { id: "active-conversations" | "archived-conversations" | "project-checkpoints" | "git-diff-snapshots" | "temporary-chats"; byteSize: number; itemCount: number; estimated?: boolean; }
export interface ArchivedConversation { id: string; path: string; name: string; cwd: string; modifiedAt: number; byteSize: number; deletable: boolean; deleteError?: string; worktreePath?: string; restorable?: boolean; restoreError?: string; }
export interface HostStorage { hostId: string; hostName: string; categories: StorageCategory[]; archives: ArchivedConversation[]; warnings: string[]; error?: string; }
export interface StorageReport { hosts: HostStorage[]; }
export interface ChatMessage { contextCheckpoint?: boolean; }
export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; }
export interface PromptContextInfo {
  userTimestamp?: number;
  systemPrompt: string;
  instructions: Array<{ path: string; content: string }>;
  tools: Array<{ name: string; description: string; parameters?: unknown }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
  tokens: { system: number; instructions: number; tools: number; skills: number };
}
export interface PendingMessage { id: string; message: string; behavior: "steer" | "followUp"; images?: ImageAttachment[]; retry?: boolean; }
export interface AgentState { viewers?: number; pendingMessages?: PendingMessage[]; model: Model | null; thinkingLevel: string; isStreaming: boolean; isCompacting?: boolean; isPaused?: boolean; isPausing?: boolean; sessionFile?: string; sessionId: string; sessionName?: string; messageCount: number; pendingMessageCount: number; activity?: string; contextUsage?: ContextUsage; }
export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; error?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }
export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown>; contextWindow?: number; input?: ("text" | "image")[]; }
export interface AgentProfile { name: string; model: string; effort: string; fastMode?: boolean; extensions?: string[]; path_systemprompt: string; path_agentprompt: string; tools: string[]; skills: string[]; mcpServers: McpServer[]; }
export interface AgentConfig { agents: AgentProfile[]; fastModeModels?: string[]; }
export interface DefinedAgentsCapability { version: number; active: string; locked?: boolean; saved?: boolean; unavailable?: boolean; config: AgentConfig; }
export interface AgentConfigChange { hostId: string; revision: number; }
export interface SettingsChange { settings: AppSettings; agentConfigChange?: AgentConfigChange; }
export interface RpcCommand { id?: string; type: string; [key: string]: unknown; }
export interface RpcEvent { type: string; [key: string]: unknown; }
export interface ToolConfig { name: string; description: string; enabled: boolean; builtin?: boolean; }
export interface SkillConfig { name: string; path: string; description: string; enabled: boolean; userInvokedOnly?: boolean; }
export interface McpServer { id: string; name: string; transport?: "stdio" | "http"; command: string; args: string; url?: string; headers?: string; enabled: boolean; startupTimeoutSec?: number; injectAgentId?: boolean; status?: "starting" | "connected" | "stopped" | "error"; error?: string; }
export interface RemoteHost { id: string; name: string; target: string; piPath: string; }
export interface DirectoryListing { path: string; parent?: string; directories: string[]; }
export interface SlashCommand { name: string; description?: string; source: "builtin" | "extension" | "prompt" | "skill"; sourceInfo?: { source?: string }; }
export interface ImageAttachment { type: "image"; data: string; mimeType: string; name?: string; }
export interface ComposerUpload { id: string; name: string; kind: "image" | "text"; byteSize: number; image?: ImageAttachment; text?: string; }
export interface WorktreeSetupScript { id: string; name: string; script: string; cleanupScript?: string; enabled: boolean; projectPath?: string; hostId?: string; }
 export interface AppSettings { worktreeSetupScripts: WorktreeSetupScript[]; defaultAgent?: string; defaultModel: string; hiddenModels: string[]; knownModels?: string[]; defaultThinking: string; defaultFastMode: boolean; contextWindowCap: number; contextWindowCapEnabled: boolean; autoRetry: boolean; debugMode: boolean; keybindings: import("./lib/keybindings").Keybindings; tools: ToolConfig[]; skills: SkillConfig[]; hosts: RemoteHost[]; }
export interface CodexUsage { remainingPercent: number; resetAt?: number; }
export interface UsageWindow { status: string; remainingPercent: number; resetAt?: number; }
export interface OpencodeGoUsage { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow; }
export interface ToolPathMapping { toolCallId: string; path: string; absolutePath: string; canonicalPath: string; }
export type GitDiffSnapshot = string | { patch: string; repositoryRoot: string; toolPaths?: ToolPathMapping[] };
export type GitDiffSnapshots = Record<string, GitDiffSnapshot>;
export interface FileChangeSnapshot { id: string; cwd: string; toolCallIds: string[]; toolPaths?: ToolPathMapping[]; paths: string[]; patch: string; warnings: string[]; }
export interface ChatMessage { toolCallId?: string; details?: unknown; fileChanges?: FileChangeSnapshot[]; toolDiff?: { path?: string; patch: string }; }
export interface ChatMessage { deferredToolPayload?: string; toolPayloadLoaded?: boolean; toolPayloadVersion?: number; loadedToolPayloadVersion?: number; loadToolPayload?: () => Promise<void>; }

export type PendingMessageAction = "steer" | "followUp" | "remove" | "moveUp" | "moveDown" | { type: "move"; targetId: string; edge: "before" | "after" };
