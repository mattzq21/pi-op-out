import { defaultSettings } from "../defaults";
import type { AgentState, AppSettings, ChatMessage, Model, PiTransport, RpcCommand, RpcEvent, SessionSummary } from "../types";
import { uid } from "./content";

const sessions: SessionSummary[] = [
  { id: "pi-ui", path: "mock://pi-ui", name: "Design desktop shell", project: "pi-ai", cwd: "/Users/demo/code/pi-ai", updatedAt: new Date().toISOString(), preview: "The session rail and branching flow are ready.", messageCount: 8, starred: true },
  { id: "rpc", path: "mock://rpc", name: "Wire RPC transport", project: "pi-ai", cwd: "/Users/demo/code/pi-ai", updatedAt: new Date(Date.now() - 38 * 60_000).toISOString(), preview: "Connect the process event stream.", messageCount: 14 },
  { id: "auth", path: "mock://auth", name: "Fix token refresh", project: "northstar", cwd: "/Users/demo/code/northstar", cwdExists: false, updatedAt: new Date(Date.now() - 86_400_000).toISOString(), preview: "Refresh is now serialized.", messageCount: 21 },
  { id: "query", path: "mock://query", name: "Optimize project query", project: "northstar", cwd: "/Users/demo/code/northstar", updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), preview: "Added the composite index.", messageCount: 11 }
];

const starter: ChatMessage[] = [
  { id: "u1", entryId: "entry-u1", role: "user", content: "Build a desktop shell for pi that feels focused, fast, and native.", timestamp: Date.now() - 180_000 },
  { id: "a1", entryId: "entry-a1", role: "assistant", model: "deepseek-v4-flash", timestamp: Date.now() - 175_000, content: "I mapped the product around three durable surfaces: the active conversation, project-grouped history, and configuration. The center stays quiet so tool activity and decisions remain easy to scan.\n\nThe native layer will speak pi’s JSONL RPC protocol directly, which keeps the GUI thin and preserves every CLI capability—including steering, follow-ups, branching, session switching, model selection, and compaction." },
  { id: "u2", entryId: "entry-u2", role: "user", content: "Make branching accessible under every response.", timestamp: Date.now() - 120_000 },
  { id: "a2", entryId: "entry-a2", role: "assistant", model: "deepseek-v4-flash", timestamp: Date.now() - 115_000, content: "Done. Each assistant response has a compact action row with copy, retry, and branch controls. Branching forks at that response’s session entry, keeps the original intact, and opens the new branch immediately." }
];

export class MockTransport implements PiTransport {
  mode = "browser" as const;
  private listeners = new Set<(event: RpcEvent) => void>();
  private sessions = structuredClone(sessions);
  private histories = new Map<string, ChatMessage[]>([["pi-ui", structuredClone(starter)]]);
  private messages = [...starter];
  private state: AgentState = { model: { provider: "openrouter", id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 128000 }, thinkingLevel: "high", isStreaming: false, sessionId: "pi-ui", sessionName: "Design desktop shell", messageCount: starter.length, pendingMessageCount: 0 };
  private settings = structuredClone(defaultSettings);
  async connect() { this.emit({ type: "connected" }); }
  async disconnect() {}
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: RpcEvent) { this.listeners.forEach((listener) => listener(event)); }
  async listSessions() { return structuredClone(this.sessions); }
  async relocateSession(sessionPath: string, cwd: string) { const session = this.sessions.find((item) => item.path === sessionPath); if (!session) throw new Error("Session not found"); session.cwd = cwd; session.project = cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace"; session.cwdExists = true; }
  async loadSettings() { return structuredClone(this.settings); }
  async saveSettings(settings: AppSettings) { this.settings = structuredClone(settings); localStorage.setItem("pi-ui-settings", JSON.stringify(settings)); }
  async openProject(cwd: string) {
    const project = cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace"; const candidate = this.sessions.find((session) => session.project === project);
    if (candidate) await this.command({ type: "switch_session", sessionPath: candidate.path }); else { await this.command({ type: "new_session" }); const session = this.sessions.find((item) => item.id === this.state.sessionId); if (session) { session.cwd = cwd; session.project = project; } }
  }

  async command<T>(command: RpcCommand): Promise<T> {
    switch (command.type) {
      case "get_state": return structuredClone(this.state) as T;
      case "get_messages": return { messages: structuredClone(this.messages) } as T;
      case "get_entries": return { entries: this.messages.map((message, index) => ({ type: "message", id: message.entryId, parentId: index ? this.messages[index - 1].entryId : null, timestamp: new Date(message.timestamp ?? Date.now()).toISOString(), message })), leafId: this.messages.at(-1)?.entryId ?? null } as T;
      case "get_available_models": return { models: [
        this.state.model,
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
        { provider: "openai-codex", id: "gpt-5.6", name: "GPT-5.6", reasoning: true, contextWindow: 272000 }
      ].filter(Boolean) as Model[] } as T;
      case "get_available_thinking_levels": return { levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } as T;
      case "get_commands": return { commands: [{ name: "review", description: "Review the current changes", source: "prompt" }, { name: "skill:frontend", description: "Use the frontend skill", source: "skill" }, { name: "session-name", description: "Rename this session", source: "extension" }] } as T;
      case "set_model": this.state.model = { provider: String(command.provider), id: String(command.modelId), name: String(command.modelId) }; return this.state.model as T;
      case "set_thinking_level": this.state.thinkingLevel = String(command.level); return undefined as T;
      case "set_session_name": { const name = String(command.name); this.state.sessionName = name; const session = this.sessions.find((item) => item.id === this.state.sessionId); if (session) session.name = name; return undefined as T; }
      case "get_session_stats": return { sessionFile: `mock://${this.state.sessionId}`, sessionId: this.state.sessionId, userMessages: this.messages.filter((message) => message.role === "user").length, assistantMessages: this.messages.filter((message) => message.role === "assistant").length, toolCalls: 0, toolResults: 0, totalMessages: this.messages.length, tokens: { input: 2840, output: 612, cacheRead: 1100, cacheWrite: 0, total: 4552 }, cost: .0064, contextUsage: { tokens: 3452, contextWindow: this.state.model?.contextWindow ?? 128000, percent: 2.7 } } as T;
      case "get_tree": return { tree: this.messages.length ? [{ entry: { type: "message", id: this.messages[0].entryId, parentId: null, message: this.messages[0] }, children: this.messages.slice(1).reduceRight<Array<Record<string, unknown>>>((children, message) => [{ entry: { type: "message", id: message.entryId, message }, children }], []) }] : [], leafId: this.messages.at(-1)?.entryId ?? null } as T;
      case "compact": this.emit({ type: "compaction_start", reason: "manual" }); this.emit({ type: "compaction_end", reason: "manual", result: { tokensBefore: 3452, estimatedTokensAfter: 980 } }); return { summary: "Browser transport compaction summary", tokensBefore: 3452, estimatedTokensAfter: 980 } as T;
      case "export_html": return { path: `/tmp/${this.state.sessionId}.html` } as T;
      case "bash": { const id = String(command.id); const output = `$ ${String(command.command)}\nBrowser transport: command execution is available in the native Tauri app.\n`; this.emit({ type: "bash_execution_update", id, delta: output }); return { output, exitCode: 0, cancelled: false, truncated: false } as T; }
      case "abort_bash": return undefined as T;
      case "clone": {
        const id = uid("clone"); const name = `${this.state.sessionName ?? "Session"} — copy`; this.state = { ...this.state, sessionId: id, sessionName: name }; this.messages = structuredClone(this.messages); this.histories.set(id, this.messages); this.sessions.unshift({ id, path: `mock://${id}`, name, project: "pi-ai", cwd: "/Users/demo/code/pi-ai", updatedAt: new Date().toISOString(), preview: "Cloned conversation", messageCount: this.messages.length }); this.emit({ type: "session_switched" }); return { cancelled: false } as T;
      }
      case "abort": this.state.isStreaming = false; this.emit({ type: "agent_end" }); return undefined as T;
      case "new_session": {
        const id = uid("session"); this.messages = []; this.histories.set(id, []); this.sessions.unshift({ id, path: `mock://${id}`, name: "Untitled session", project: "pi-ai", cwd: "/Users/demo/code/pi-ai", updatedAt: new Date().toISOString(), preview: "New conversation", messageCount: 0 });
        this.state = { ...this.state, sessionId: id, sessionName: "Untitled session", messageCount: 0 }; this.emit({ type: "session_switched" }); return { cancelled: false } as T;
      }
      case "switch_session": {
        const id = String(command.sessionPath).replace("mock://", ""); const session = this.sessions.find((item) => item.id === id); if (!session) throw new Error("Session not found");
        this.messages = structuredClone(this.histories.get(id) ?? [{ id: uid("assistant"), entryId: uid("entry"), role: "assistant", content: `This is the browser preview for **${session.name}**. Native Pi sessions load their complete persisted message tree.`, timestamp: Date.now(), model: this.state.model?.id }]);
        this.histories.set(id, this.messages); this.state = { ...this.state, sessionId: id, sessionName: session.name, messageCount: this.messages.length }; this.emit({ type: "session_switched" }); return { cancelled: false } as T;
      }
      case "fork": {
        const index = this.messages.findIndex((m) => m.entryId === command.entryId);
        if (index >= 0) this.messages = this.messages.slice(0, index + 1);
        this.state.sessionId = uid("branch"); this.state.sessionName = `${this.state.sessionName ?? "Session"} — branch`;
        this.histories.set(this.state.sessionId, this.messages); this.sessions.unshift({ id: this.state.sessionId, path: `mock://${this.state.sessionId}`, name: this.state.sessionName, project: "pi-ai", cwd: "/Users/demo/code/pi-ai", updatedAt: new Date().toISOString(), preview: "Branched conversation", messageCount: this.messages.length });
        this.emit({ type: "session_switched" }); return { cancelled: false, sessionFile: `mock://${this.state.sessionId}` } as T;
      }
      case "prompt": return this.mockPrompt(String(command.message ?? "")) as T;
      case "steer": case "follow_up": return { queued: true } as T;
      default: return {} as T;
    }
  }

  private async mockPrompt(text: string) {
    const user: ChatMessage = { id: uid("user"), entryId: uid("entry"), role: "user", content: text, timestamp: Date.now() };
    this.messages.push(user); this.state.isStreaming = true; this.emit({ type: "message_end", message: user }); this.emit({ type: "agent_start" });
    const assistant: ChatMessage = { id: uid("assistant"), entryId: uid("entry"), role: "assistant", model: this.state.model?.id, content: "", timestamp: Date.now(), streaming: true };
    this.messages.push(assistant); this.emit({ type: "message_start", message: assistant });
    const response = "I’m running in the browser test transport, so no model was charged. The same interaction is sent to the local pi process in the Tauri app, where tool calls and text stream into this conversation in real time.";
    for (const chunk of response.match(/.{1,18}/g) ?? []) {
      await new Promise((resolve) => setTimeout(resolve, 12));
      assistant.content += chunk; this.emit({ type: "message_update", message: { ...assistant } });
    }
    assistant.streaming = false; this.state.isStreaming = false; this.state.messageCount = this.messages.length;
    this.histories.set(this.state.sessionId, this.messages); const session = this.sessions.find((item) => item.id === this.state.sessionId); if (session) { session.preview = text; session.messageCount = this.messages.length; session.updatedAt = new Date().toISOString(); }
    this.emit({ type: "message_end", message: { ...assistant } }); this.emit({ type: "agent_end" });
    return { accepted: true };
  }
}
