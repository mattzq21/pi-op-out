export type Role = "user" | "assistant" | "tool" | "system";
export type ContentPart = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; partialArgs?: string };
export interface ChatMessage { id: string; entryId?: string; role: Role; content: string | ContentPart[]; customType?: string; timestamp?: number; completedAt?: number; model?: string; streaming?: boolean; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string; toolName?: string; toolStatus?: "running" | "done" | "error"; promptContext?: PromptContextInfo; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }; }
export interface SessionSummary { id: string; path: string; name: string; project: string; cwd: string; cwdExists?: boolean; projectRoot?: string | null; projectKind?: "no-repo" | "main" | "worktree" | null; preview: string; messageCount: number; apiCost: number; hostId?: string; hostName?: string; }
export interface ChatMessage { sequenceMarkerAuthorized?: boolean; contextCheckpoint?: boolean; }
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
export interface AgentState { pendingMessages?: PendingMessage[]; model: Model | null; thinkingLevel: string; isStreaming: boolean; isPaused?: boolean; isPausing?: boolean; sessionFile?: string; sessionId: string; sessionName?: string; messageCount: number; pendingMessageCount: number; activity?: string; contextUsage?: ContextUsage; }
export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; error?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }
export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; }
export interface AgentProfile { name: string; description: string; model: string; effort: string; systemPrompt: string; developerPrompt: string; agentsMd: string; tools: string[]; skills: string[]; mcpServers: string[]; }
export interface AgentConfig { agents: AgentProfile[]; }
export interface DefinedAgentsCapability { version: number; active: string; config: { agents: AgentProfile[] }; }
export interface RpcCommand { id?: string; type: string; [key: string]: unknown; }
export interface RpcEvent { type: string; [key: string]: unknown; }
export interface ToolConfig { name: string; description: string; enabled: boolean; builtin?: boolean; }
export interface SkillConfig { name: string; path: string; description: string; enabled: boolean; userInvokedOnly?: boolean; }
export interface McpServer { id: string; name: string; transport?: "stdio" | "http"; command: string; args: string; url?: string; headers?: string; enabled: boolean; status?: "connected" | "stopped" | "error"; error?: string; }
export interface RemoteHost { id: string; name: string; target: string; piPath: string; }
export interface DictionaryEntry { word: string; replacement: string; }
export interface PromptDictionary { id: string; name: string; entries: DictionaryEntry[]; }
export interface DirectoryListing { path: string; parent?: string; directories: string[]; }
export interface SlashCommand { name: string; description?: string; source: "builtin" | "extension" | "prompt" | "skill"; sourceInfo?: { source?: string }; }
export interface ImageAttachment { type: "image"; data: string; mimeType: string; name?: string; }
export interface ComposerUpload { id: string; name: string; kind: "image" | "text"; byteSize: number; image?: ImageAttachment; text?: string; }
export interface AppSettings { defaultModel: string; hiddenModels: string[]; defaultThinking: string; contextWindowCap: number; autoCompaction: boolean; autoRetry: boolean; debugMode: boolean; keybindings: import("./lib/keybindings").Keybindings; tools: ToolConfig[]; skills: SkillConfig[]; mcpServers: McpServer[]; hosts: RemoteHost[]; dictionaries: PromptDictionary[]; activeDictionaryIds: string[]; }
export interface CodexUsage { remainingPercent: number; resetAt?: number; }
export type GitDiffSnapshot = string;
export type GitDiffSnapshots = Record<string, GitDiffSnapshot>;
