export type Role = "user" | "assistant" | "tool" | "system";
export type ContentPart = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export interface ChatMessage { id: string; entryId?: string; role: Role; content: string | ContentPart[]; timestamp?: number; model?: string; streaming?: boolean; toolName?: string; toolStatus?: "running" | "done" | "error"; }
export interface SessionSummary { id: string; path: string; name: string; project: string; cwd: string; updatedAt: string; preview: string; messageCount: number; starred?: boolean; }
export interface AgentState { model: Model | null; thinkingLevel: string; isStreaming: boolean; sessionFile?: string; sessionId: string; sessionName?: string; messageCount: number; pendingMessageCount: number; activity?: string; }
export interface ExtensionUiRequest { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; notifyType?: "info" | "warning" | "error"; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor"; text?: string; }
export interface Model { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; }
export interface RpcCommand { id?: string; type: string; [key: string]: unknown; }
export interface RpcEvent { type: string; [key: string]: unknown; }
export interface ToolConfig { name: string; description: string; enabled: boolean; builtin?: boolean; }
export interface SkillConfig { name: string; path: string; description: string; enabled: boolean; scope: "global" | "project"; }
export interface McpServer { id: string; name: string; command: string; args: string; enabled: boolean; status?: "connected" | "stopped" | "error"; }
export interface SlashCommand { name: string; description?: string; source: "extension" | "prompt" | "skill"; path?: string; }
export interface ImageAttachment { type: "image"; data: string; mimeType: string; name?: string; }
export interface AppSettings { theme: "light" | "dark" | "system"; defaultModel: string; defaultThinking: string; autoCompaction: boolean; autoRetry: boolean; notifications: boolean; steeringMode: "all" | "one-at-a-time"; followUpMode: "all" | "one-at-a-time"; tools: ToolConfig[]; skills: SkillConfig[]; mcpServers: McpServer[]; }

export interface PiTransport {
  mode: "native" | "browser";
  connect(cwd?: string, sessionPath?: string): Promise<void>;
  disconnect(): Promise<void>;
  command<T = unknown>(command: RpcCommand): Promise<T>;
  subscribe(listener: (event: RpcEvent) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  loadSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  openProject(cwd: string): Promise<void>;
}
