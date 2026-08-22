import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, MessageSquare, Plus, Settings, Terminal } from "lucide-react";
import { ChatView } from "./components/ChatView";
import { IconButton } from "./components/IconButton";
import { SessionPanel } from "./components/SessionPanel";
import { SettingsView } from "./components/SettingsView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { SessionInspector, type SessionStats, type TreeNode } from "./components/SessionInspector";
import { TerminalView, type TerminalRun } from "./components/TerminalView";
import { defaultSettings } from "./defaults";
import { textOf } from "./lib/content";
import { createTransport } from "./lib/transport";
import type { AgentState, AppSettings, ChatMessage, ExtensionUiRequest, ImageAttachment, Model, RpcEvent, SessionSummary, SlashCommand } from "./types";

const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };
type PiEntry = { type: string; id: string; parentId: string | null; message?: Omit<ChatMessage, "id" | "entryId"> & { role: string; timestamp?: number } };

function normalizeMessage(message: Record<string, unknown>, entryId?: string): ChatMessage {
  const stamp = Number(message.timestamp || Date.now());
  return { ...(message as unknown as ChatMessage), id: entryId || `live-${message.role}-${stamp}`, entryId, role: (message.role === "toolResult" ? "tool" : message.role) as ChatMessage["role"], toolStatus: message.role === "toolResult" ? (message.isError ? "error" : "done") : undefined, timestamp: stamp };
}

function rpcContent(value: unknown): ChatMessage["content"] { const content = (value as { content?: ChatMessage["content"] })?.content; return content ?? ""; }

function branchMessages(entries: PiEntry[], leafId: string | null): ChatMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const branch: PiEntry[] = []; let cursor = leafId;
  while (cursor) { const entry = byId.get(cursor); if (!entry) break; branch.unshift(entry); cursor = entry.parentId; }
  return branch.filter((entry) => entry.type === "message" && entry.message).map((entry) => normalizeMessage(entry.message as unknown as Record<string, unknown>, entry.id));
}

export default function App() {
  const transport = useMemo(createTransport, []); const [view, setView] = useState<"chat" | "settings" | "terminal">("chat");
  const [state, setState] = useState(emptyState); const [messages, setMessages] = useState<ChatMessage[]>([]); const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [commands, setCommands] = useState<SlashCommand[]>([]); const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]); const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const settingsRef = useRef(settings); const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [panelOpen, setPanelOpen] = useState(true); const [query, setQuery] = useState(""); const [connected, setConnected] = useState(false); const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<ExtensionUiRequest>(); const [notice, setNotice] = useState<{ title: string; message: string }>();
  const [statuses, setStatuses] = useState<Record<string, string>>({}); const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [renameOpen, setRenameOpen] = useState(false); const [inspector, setInspector] = useState<{ stats: SessionStats; tree: TreeNode[]; leafId: string | null }>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [terminalRuns, setTerminalRuns] = useState<TerminalRun[]>([]);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { const query = window.matchMedia?.("(prefers-color-scheme: dark)"); if (!query) return; const update = () => setSystemDark(query.matches); query.addEventListener("change", update); return () => query.removeEventListener("change", update); }, []);

  const refresh = useCallback(async () => {
    const [nextState, response, nextSessions, modelResponse, thinkingResponse, commandResponse, nextSettings] = await Promise.all([
      transport.command<AgentState>({ type: "get_state" }), transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }), transport.listSessions(),
      transport.command<{ models: Model[] }>({ type: "get_available_models" }), transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }), transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" }), transport.loadSettings()
    ]);
    setState(nextState); setMessages(branchMessages(response.entries, response.leafId)); setSessions(nextSessions); setModels(modelResponse.models); setCommands(commandResponse.commands); setThinkingLevels(thinkingResponse.levels); setSettings(nextSettings); return nextSettings;
  }, [transport]);

  const configureRuntime = useCallback((value: AppSettings) => Promise.all([
    transport.command({ type: "set_auto_compaction", enabled: value.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: value.autoRetry }),
    transport.command({ type: "set_steering_mode", mode: value.steeringMode }), transport.command({ type: "set_follow_up_mode", mode: value.followUpMode })
  ]), [transport]);

  useEffect(() => {
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      if (event.type === "agent_start") setState((current) => ({ ...current, isStreaming: true }));
      if (event.type === "agent_end" || event.type === "agent_settled") { setState((current) => ({ ...current, isStreaming: false, activity: undefined })); if (event.type === "agent_settled" && document.hidden && settingsRef.current.notifications && "Notification" in window && Notification.permission === "granted") new Notification("Pi finished", { body: "Your coding agent is ready for you." }); }
      if (event.type === "message_start" || event.type === "message_end") {
        const message = normalizeMessage(event.message as Record<string, unknown>); setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]);
        if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      }
      if (event.type === "message_update") { const message = { ...normalizeMessage(event.message as Record<string, unknown>), streaming: true }; setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]); }
      if (event.type === "tool_execution_start") { const message: ChatMessage = { id: String(event.toolCallId), role: "tool", toolName: String(event.toolName), toolStatus: "running", content: JSON.stringify(event.args ?? {}, null, 2), timestamp: Date.now() }; setMessages((current) => [...current.filter((item) => item.id !== message.id), message]); }
      if (event.type === "tool_execution_update") setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.partialResult), toolStatus: "running" } : item));
      if (event.type === "tool_execution_end") setMessages((current) => current.map((item) => item.id === event.toolCallId ? { ...item, content: rpcContent(event.result), toolStatus: event.isError ? "error" : "done" } : item));
      if (event.type === "queue_update") { const pending = [...((event.steering as unknown[]) ?? []), ...((event.followUp as unknown[]) ?? [])].length; setState((current) => ({ ...current, pendingMessageCount: pending })); }
      if (event.type === "bash_execution_update") setTerminalRuns((current) => current.map((run) => run.id === event.id ? { ...run, output: run.output + String(event.delta ?? "") } : run));
      if (event.type === "compaction_start") setState((current) => ({ ...current, activity: "Compacting context…" }));
      if (event.type === "compaction_end") setState((current) => ({ ...current, activity: undefined }));
      if (event.type === "auto_retry_start") setState((current) => ({ ...current, activity: `Retrying · attempt ${event.attempt}` }));
      if (event.type === "extension_error") setNotice({ title: "Extension error", message: String(event.error ?? "An extension failed") });
      if (event.type === "extension_ui_request") { const request = event as unknown as ExtensionUiRequest;
        if (request.method === "notify") setNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "Pi extension", message: request.message || "Notification" });
        else if (request.method === "setStatus" && request.statusKey) setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
        else if (request.method === "setWidget" && request.widgetKey) setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = request.widgetLines; else delete next[request.widgetKey!]; return next; });
        else if (request.method === "setTitle" && request.title) document.title = request.title;
        else if (request.method === "set_editor_text") window.dispatchEvent(new CustomEvent("pi:set-editor-text", { detail: request.text || "" }));
        else setDialog(request);
      }
      if (event.type === "session_switched") void refresh();
    });
    transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => setConnected(true)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { unsubscribe(); void transport.disconnect(); };
  }, [configureRuntime, refresh, transport]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (behavior) { await transport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); setState((current) => ({ ...current, pendingMessageCount: current.pendingMessageCount + 1 })); return; }
    await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
  };
  const branch = async (message: ChatMessage) => { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (!user) return; await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); };
  const retry = async (message: ChatMessage) => { const index = messages.findIndex((item) => item.id === message.id); const previous = messages.slice(0, index).reverse().find((item) => item.role === "user"); if (previous) await send(textOf(previous.content)); };
  const newSession = async () => { await transport.command({ type: "new_session" }); await refresh(); setView("chat"); };
  const selectSession = async (session: SessionSummary) => { if (session.id === state.sessionId) return; await transport.command({ type: "switch_session", sessionPath: session.path }); await refresh(); };
  const setModel = async (model: Model) => { await transport.command({ type: "set_model", provider: model.provider, modelId: model.id }); setState((current) => ({ ...current, model })); };
  const setThinking = async (level: string) => { await transport.command({ type: "set_thinking_level", level }); setState((current) => ({ ...current, thinkingLevel: level })); };
  const saveSettings = async (value: AppSettings) => { if (value.notifications && "Notification" in window && Notification.permission === "default") await Notification.requestPermission(); await transport.saveSettings(value); await configureRuntime(value); setSettings(value); await refresh(); };
  const sessionAction = async (action: "rename" | "clone" | "compact" | "export" | "inspect") => {
    if (action === "rename") { setRenameOpen(true); return; }
    if (action === "clone") { await transport.command({ type: "clone" }); await refresh(); return; }
    if (action === "compact") { setState((current) => ({ ...current, activity: "Compacting context…" })); await transport.command({ type: "compact" }); setState((current) => ({ ...current, activity: undefined })); await refresh(); return; }
    if (action === "export") { const result = await transport.command<{ path: string }>({ type: "export_html" }); setNotice({ title: "Conversation exported", message: result.path }); return; }
    const [stats, tree] = await Promise.all([transport.command<SessionStats>({ type: "get_session_stats" }), transport.command<{ tree: TreeNode[]; leafId: string | null }>({ type: "get_tree" })]); setInspector({ stats, tree: tree.tree, leafId: tree.leafId });
  };
  const runBash = async (command: string) => { const id = `bash-${Date.now()}`; setTerminalRuns((current) => [...current, { id, command, output: "", running: true }]); try { const result = await transport.command<{ output: string; exitCode: number }>({ id, type: "bash", command }); setTerminalRuns((current) => current.map((run) => run.id === id ? { ...run, output: run.output || result.output, exitCode: result.exitCode, running: false } : run)); } catch (reason) { setTerminalRuns((current) => current.map((run) => run.id === id ? { ...run, output: `${run.output}\n${String(reason)}`, exitCode: 1, running: false } : run)); } };

  return <div className={`app ${settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme}`}>
    <aside className="icon-rail"><nav><IconButton label="New conversation" onClick={newSession}><Plus size={19} /></IconButton><IconButton label="Conversations" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><MessageSquare size={18} /></IconButton><IconButton label="Projects" onClick={() => setProjectOpen(true)}><FolderGit2 size={18} /></IconButton><IconButton label="Terminal" className={view === "terminal" ? "active" : ""} onClick={() => setView("terminal")}><Terminal size={18} /></IconButton></nav><div className="rail-bottom"><span className={`native-status ${connected ? "online" : ""}`} title={connected ? `${transport.mode} transport connected` : "Connecting"} /><IconButton label="Settings" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={19} /></IconButton><button className="user-chip" aria-label="Profile">JD</button></div></aside>
    {view === "chat" ? <><ChatView state={state} messages={messages} models={models} commands={commands} thinkingLevels={thinkingLevels} panelOpen={panelOpen} widgets={Object.values(widgets).flat()} statuses={Object.values(statuses)} onPanelToggle={() => setPanelOpen((open) => !open)} onSend={send} onAbort={() => transport.command({ type: "abort" })} onOpenTerminal={() => setView("terminal")} onBranch={branch} onRetry={retry} onModel={setModel} onThinking={setThinking} onSessionAction={sessionAction} />{panelOpen && <SessionPanel sessions={sessions} activeId={state.sessionId} query={query} onQuery={setQuery} onSelect={selectSession} onNew={newSession} onProject={() => setProjectOpen(true)} />}</> : view === "settings" ? <SettingsView settings={settings} onSave={saveSettings} /> : <TerminalView cwd={sessions.find((session) => session.id === state.sessionId)?.cwd || "Active project"} runs={terminalRuns} onRun={runBash} onAbort={() => transport.command({ type: "abort_bash" })} onClear={() => setTerminalRuns([])} />}
    {error && <div className="error-toast"><strong>Pi could not connect</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
    {notice && <div className="error-toast"><strong>{notice.title}</strong><span>{notice.message}</span><button onClick={() => setNotice(undefined)}>×</button></div>}
    {dialog && <ExtensionDialog request={dialog} onRespond={(response) => { void transport.command({ type: "extension_ui_response", id: dialog.id, ...response }); setDialog(undefined); }} />}
    {renameOpen && <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: state.sessionName || "" }} onRespond={(response) => { setRenameOpen(false); if (typeof response.value === "string" && response.value.trim()) { const name = response.value.trim(); void transport.command({ type: "set_session_name", name }).then(() => { setState((current) => ({ ...current, sessionName: name })); void refresh(); }); } }} />}
    {inspector && <SessionInspector {...inspector} onClose={() => setInspector(undefined)} />}
    {projectOpen && <ExtensionDialog request={{ type: "extension_ui_request", id: "open-project", method: "input", title: "Open project", placeholder: "/path/to/project", prefill: sessions.find((session) => session.id === state.sessionId)?.cwd || "" }} onRespond={(response) => { setProjectOpen(false); if (typeof response.value === "string" && response.value.trim()) { setConnected(false); void transport.openProject(response.value.trim()).then(() => refresh()).then((value) => configureRuntime(value)).then(() => { setConnected(true); setView("chat"); }).catch((reason: unknown) => setError(String(reason))); } }} />}
  </div>;
}
