export type Role = "user" | "assistant" | "tool" | "system";
export type ContentPart = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; partialArgs?: string };
export interface ChatMessage { id: string; entryId?: string; role: Role; content: string | ContentPart[]; customType?: string; timestamp?: number; completedAt?: number; model?: string; streaming?: boolean; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string; toolName?: string; toolStatus?: "running" | "done" | "error"; promptContext?: PromptContextInfo; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }; }
export interface SessionSummary { id: string; path: string; name: string; project: string; cwd: string; cwdExists?: boolean; preview: string; messageCount: number; apiCost: number; hostId?: string; hostName?: string; }
export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; }
export interface PromptContextInfo {
  systemPrompt: string;
  instructions?: Array<{ path: string; content: string }>;
  tools: Array<{ name: string; description: string; parameters?: unknown }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
  tokens: { system: number; instructions?: number; tools: number; skills: number };
}
export interface AgentState { model: Model | null; thinkingLevel: string; isStreaming: boolean; sessionFile?: string; sessionId: string; sessionName?: string; messageCount: number; pendingMessageCount: number; activity?: string; contextUsage?: ContextUsage; }
export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; error?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }
export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; }
export interface AgentProfile { name: string; description: string; model: string; effort: string; systemPrompt: string; developerPrompt: string; agentsMd: string; tools: string[]; skills: string[]; mcpServers: string[]; }
export interface PreprompterProfile { enabled: boolean; model: string; systemPrompt: string; agentsMd: string; }
export interface SequenceProfile { name: string; description: string; agents: string[]; visibleSteps: number; }
export interface OrchestrationConfig { preprompter: PreprompterProfile; agents: AgentProfile[]; sequences: SequenceProfile[]; }
export interface OrchestrationCapability { version: number; active: string; currentAgent?: string; config: OrchestrationConfig; }
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
export interface SavedTerminalState { activeId: string; tabs: Array<{ id: string; output: string; started: boolean; exited?: boolean }> }
export interface AppSettings { defaultModel: string; defaultThinking: string; contextWindowCap: number; autoCompaction: boolean; autoRetry: boolean; debugMode: boolean; keybindings: import("./lib/keybindings").Keybindings; tools: ToolConfig[]; skills: SkillConfig[]; mcpServers: McpServer[]; hosts: RemoteHost[]; dictionaries: PromptDictionary[]; activeDictionaryIds: string[]; }
export interface CodexUsage { remainingPercent: number; resetAt?: number; }
export interface SessionEntries { entries: Array<Record<string, unknown>>; leafId: string | null; }

export type GitDiffSnapshot = string;
export type GitDiffSnapshots = Record<string, GitDiffSnapshot>;

export interface PiTransport {
  connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string, ephemeral?: boolean): Promise<void>;
  disconnect(): Promise<void>;
  command<T = unknown>(command: RpcCommand): Promise<T>;
  subscribe(listener: (event: RpcEvent) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  loadSessionEntries(sessionPath: string, hostId?: string): Promise<SessionEntries>;
  captureGitTree(cwd: string, hostId?: string): Promise<string | null>;
  loadGitDiff(cwd: string, baseTree: string, hostId?: string): Promise<GitDiffSnapshot | null>;
  loadGitDiffs(sessionPath: string, hostId?: string): Promise<GitDiffSnapshots>;
  saveGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId?: string): Promise<void>;
  archiveSession(sessionPath: string, hostId?: string, terminalState?: SavedTerminalState): Promise<void>;
  deleteSession(sessionPath: string, hostId?: string): Promise<void>;
  relocateSession(sessionPath: string, cwd: string, hostId?: string): Promise<void>;
  openProjectDirectory(cwd: string, hostId?: string): Promise<void>;
  openLogViewer(sessionPath: string, hostId?: string): Promise<void>;
  gitBranch(): Promise<string | null>;
  loadSettings(): Promise<AppSettings>;
  loadCodexUsage(): Promise<CodexUsage>;
  saveSettings(settings: AppSettings, reconnect?: boolean): Promise<void>;
  selectProjectDirectory(defaultPath?: string): Promise<string | null>;
  homeDirectory(hostId: string): Promise<string>;
  listDirectories(hostId: string, path?: string): Promise<DirectoryListing>;
  newTemporaryChat(hostId: string): Promise<string>;
  newChat(cwd: string, hostId?: string): Promise<void>;
  openProject(cwd: string, hostId?: string): Promise<void>;
  startTerminal(terminalId: string, cwd: string, cols: number, rows: number): Promise<void>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
}
