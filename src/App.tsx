import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, MessageSquare, Plus, Settings, Terminal } from "lucide-react";
import { ChatView } from "./components/ChatView";
import { IconButton } from "./components/IconButton";
import { SessionPanel, type SessionAction } from "./components/SessionPanel";
import { SettingsView } from "./components/SettingsView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { TerminalView } from "./components/TerminalView";
import { defaultSettings } from "./defaults";
import { keybindDefinitions, matchesShortcut } from "./lib/keybindings";
import { findReplaceableAbortedTurn } from "./lib/abortedTurn";
import { createTransport } from "./lib/transport";
import type { AgentState, AppSettings, ChatMessage, ExtensionUiRequest, ImageAttachment, Model, RpcEvent, SessionSummary, SlashCommand } from "./types";

const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };
type PiEntry = { type: string; id: string; parentId: string | null; message?: Omit<ChatMessage, "id" | "entryId"> & { role: string; timestamp?: number } };
type TerminalTabState = { id: string; output: string; started: boolean; exited?: boolean };
type SessionTerminals = { activeId: string; tabs: TerminalTabState[] };
const initialTerminals = (sessionId: string): SessionTerminals => { const id = `terminal-${sessionId}-1`; return { activeId: id, tabs: [{ id, output: "", started: false }] }; };

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
  const transport = useMemo(createTransport, []); const [view, setView] = useState<"chat" | "settings">("chat");
  const [state, setState] = useState(emptyState); const [messages, setMessages] = useState<ChatMessage[]>([]); const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [commands, setCommands] = useState<SlashCommand[]>([]); const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]); const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const settingsRef = useRef(settings); const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [panelOpen, setPanelOpen] = useState(true); const [query, setQuery] = useState(""); const [connected, setConnected] = useState(false); const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<ExtensionUiRequest>(); const [notice, setNotice] = useState<{ title: string; message: string }>();
  const [statuses, setStatuses] = useState<Record<string, string>>({}); const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [renameSession, setRenameSession] = useState<SessionSummary>();
  const [relocatingSession, setRelocatingSession] = useState<SessionSummary>(); const [relocationError, setRelocationError] = useState<string>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [terminalsBySession, setTerminalsBySession] = useState<Record<string, SessionTerminals>>({});
  const terminalSessionId = state.sessionId || "new-session";
  const composerDraft = composerDrafts[terminalSessionId] ?? "";
  const sessionTerminals = terminalsBySession[terminalSessionId] ?? initialTerminals(terminalSessionId);
  const activeTerminal = sessionTerminals.tabs.find((terminal) => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { const query = window.matchMedia?.("(prefers-color-scheme: dark)"); if (!query) return; const update = () => setSystemDark(query.matches); query.addEventListener("change", update); return () => query.removeEventListener("change", update); }, []);

  const refresh = useCallback(async () => {
    const [nextState, response, nextSessions, modelResponse, thinkingResponse, commandResponse, nextSettings] = await Promise.all([
      transport.command<AgentState>({ type: "get_state" }), transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }), transport.listSessions(),
      transport.command<{ models: Model[] }>({ type: "get_available_models" }), transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }), transport.command<{ commands: SlashCommand[] }>({ type: "get_commands" }), transport.loadSettings()
    ]);
    const activeSession = nextSessions.find((session) => session.id === nextState.sessionId);
    setState({ ...nextState, sessionName: activeSession?.name ?? nextState.sessionName }); setMessages(branchMessages(response.entries, response.leafId)); setSessions(nextSessions); setModels(modelResponse.models); setCommands(commandResponse.commands); setThinkingLevels(thinkingResponse.levels); setSettings(nextSettings); return nextSettings;
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
      if (event.type === "terminal_output") setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, output: terminal.output + String(event.data ?? "") } : terminal) }])));
      if (event.type === "terminal_exit") setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal) }])));
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
      if (event.type === "session_info_changed") void refresh();
    });
    transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => setConnected(true)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { unsubscribe(); void transport.disconnect(); };
  }, [configureRuntime, refresh, transport]);

  useEffect(() => {
    if (!connected) return;
    const syncSessionNames = () => void transport.listSessions().then((nextSessions) => {
      setSessions(nextSessions);
      setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId);
        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch(() => undefined);
    const interval = window.setInterval(syncSessionNames, 1500);
    return () => window.clearInterval(interval);
  }, [connected, transport]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (behavior) { await transport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); setState((current) => ({ ...current, pendingMessageCount: current.pendingMessageCount + 1 })); return; }
    const abandoned = findReplaceableAbortedTurn(messages);
    if (abandoned) {
      let entryId = abandoned.user.entryId;
      if (!entryId) { const response = await transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); entryId = findReplaceableAbortedTurn(branchMessages(response.entries, response.leafId))?.user.entryId; }
      if (entryId) { await transport.command({ type: "fork", entryId }); await refresh(); }
    }
    await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
  };
  const branch = async (message: ChatMessage) => { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (!user) return; await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); };
  const newSession = async () => { await transport.command({ type: "new_session" }); await refresh(); setView("chat"); };
  const selectSession = async (session: SessionSummary) => { if (session.id === state.sessionId) return true; if (session.cwdExists === false) { setRelocationError(undefined); setRelocatingSession(session); return false; } try { await transport.command({ type: "switch_session", sessionPath: session.path }); await refresh(); return true; } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; } };
  const setModel = async (model: Model) => { await transport.command({ type: "set_model", provider: model.provider, modelId: model.id }); setState((current) => ({ ...current, model })); };
  const setThinking = async (level: string) => { await transport.command({ type: "set_thinking_level", level }); setState((current) => ({ ...current, thinkingLevel: level })); };
  const saveSettings = async (value: AppSettings) => { if (value.notifications && "Notification" in window && Notification.permission === "default") await Notification.requestPermission(); await transport.saveSettings(value); await configureRuntime(value); setSettings(value); await refresh(); };
  const openProject = async () => { try { const cwd = await transport.selectProjectDirectory(sessions.find((session) => session.id === state.sessionId)?.cwd); if (!cwd) return; setConnected(false); const value = await transport.openProject(cwd).then(() => refresh()); await configureRuntime(value); setConnected(true); setView("chat"); } catch (reason) { setConnected(true); setError(reason instanceof Error ? reason.message : String(reason)); } };
  const sessionAction = async (session: SessionSummary, action: SessionAction) => {
    if (action === "archive") {
      try {
        if (session.id === state.sessionId) { await transport.command({ type: "new_session" }); await refresh(); }
        await transport.archiveSession(session.path); await refresh();
      } catch (reason) { setNotice({ title: "Could not archive conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
      return;
    }
    if (!await selectSession(session)) return;
    if (action === "rename") { setRenameSession(session); return; }
    if (action === "clone") { await transport.command({ type: "clone" }); await refresh(); }
  };
  const appendTerminalOutput = (terminalId: string, data: string) => setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, output: terminal.output + data } : terminal) }])));
  const startTerminal = async (terminalId: string, cols: number, rows: number) => {
    setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); return { ...current, [terminalSessionId]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = sessions.find((session) => session.id === state.sessionId)?.cwd;
    if (!cwd) { appendTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n"); return; }
    try { await transport.startTerminal(terminalId, cwd, cols, rows); } catch (reason) { appendTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); }
  };
  const addTerminal = () => setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); const id = `terminal-${terminalSessionId}-${Date.now()}`; return { ...current, [terminalSessionId]: { activeId: id, tabs: [...session.tabs, { id, output: "", started: false }] } }; });
  const selectTerminal = (terminalId: string) => setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); return { ...current, [terminalSessionId]: { ...session, activeId: terminalId } }; });
  const deleteTerminal = () => {
    const terminalId = activeTerminal.id; const closingLast = sessionTerminals.tabs.length === 1;
    void transport.closeTerminal(terminalId).catch(() => undefined);
    if (closingLast) setTerminalOpen(false);
    setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current }; if (!tabs.length) delete next[terminalSessionId]; else next[terminalSessionId] = { activeId: tabs[0].id, tabs }; return next; });
  };
  const setComposerDraft = (value: string) => setComposerDrafts((current) => { if (value) return { ...current, [terminalSessionId]: value }; const next = { ...current }; delete next[terminalSessionId]; return next; });
  const toggleTerminal = () => { setView("chat"); setTerminalOpen((open) => !open); };

  useEffect(() => {
    const handleKeybind = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const binding = keybindDefinitions.find((item) => matchesShortcut(event, settings.keybindings[item.action]));
      if (!binding) return;
      event.preventDefault();
      if (binding.action === "newConversation") { void newSession(); return; }
      if (binding.action === "toggleConversations") { setView("chat"); setPanelOpen((open) => !open); return; }
      if (binding.action === "toggleTerminal") { toggleTerminal(); return; }
      if (binding.action === "openSettings") { setView("settings"); return; }
      setView("chat"); window.setTimeout(() => window.dispatchEvent(new Event("pi:focus-composer")), 0);
    };
    window.addEventListener("keydown", handleKeybind);
    return () => window.removeEventListener("keydown", handleKeybind);
  }, [settings.keybindings]);

  return <div className={`app ${settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme}`}>
    <aside className="icon-rail"><nav><span className={`native-status ${connected ? "online" : ""}`} title={connected ? `${transport.mode} transport connected` : "Connecting"} /><IconButton label="New conversation" onClick={newSession}><Plus size={19} /></IconButton><IconButton label="Conversations" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><MessageSquare size={18} /></IconButton><IconButton label="Projects" onClick={openProject}><FolderGit2 size={18} /></IconButton><IconButton label="Terminal" className={view === "chat" && terminalOpen ? "active" : ""} onClick={toggleTerminal}><Terminal size={18} /></IconButton></nav>{view === "chat" && panelOpen && <SessionPanel sessions={sessions} activeId={state.sessionId} query={query} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} />}<div className="rail-bottom"><IconButton label="Settings" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={19} /></IconButton></div></aside>
    {view === "chat" ? <div className="chat-workspace"><ChatView state={state} messages={messages} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={Object.values(widgets).flat()} statuses={Object.values(statuses)} draft={composerDraft} onDraftChange={setComposerDraft} onSend={send} onAbort={() => transport.command({ type: "abort" })} onOpenTerminal={() => setTerminalOpen(true)} onBranch={branch} onModel={setModel} onThinking={setThinking} />{terminalOpen && <TerminalView key={`${terminalSessionId}:${activeTerminal.id}`} cwd={messages.length > 0 ? sessions.find((session) => session.id === state.sessionId)?.cwd : undefined} terminals={sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={activeTerminal.id} output={activeTerminal.output} exited={activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={(data) => { void transport.writeTerminal(activeTerminal.id, data).catch((reason) => appendTerminalOutput(activeTerminal.id, `\r\nTerminal input failed: ${String(reason)}\r\n`)); }} onResize={(cols, rows) => { void transport.resizeTerminal(activeTerminal.id, cols, rows).catch(() => undefined); }} onDelete={deleteTerminal} onClose={() => setTerminalOpen(false)} />}</div> : <SettingsView settings={settings} onSave={saveSettings} />}
    {error && <div className="error-toast"><strong>Pi could not connect</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
    {notice && <div className="error-toast"><strong>{notice.title}</strong><span>{notice.message}</span><button onClick={() => setNotice(undefined)}>×</button></div>}
    {dialog && <ExtensionDialog request={dialog} onRespond={(response) => { void transport.command({ type: "extension_ui_response", id: dialog.id, ...response }); setDialog(undefined); }} />}
    {renameSession && <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: renameSession.name }} onRespond={(response) => { setRenameSession(undefined); if (typeof response.value === "string" && response.value.trim()) { const name = response.value.trim(); void transport.command({ type: "set_session_name", name }).then(() => { setState((current) => ({ ...current, sessionName: name })); void refresh(); }); } }} />}
    {relocatingSession && <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${relocatingSession.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${relocatingSession.cwd}. Enter its new location to open this conversation.`, error: relocationError, placeholder: "Replacement project directory", prefill: sessions.find((session) => session.id === state.sessionId && session.cwdExists !== false)?.cwd || "" }} onRespond={(response) => { if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; } const cwd = typeof response.value === "string" ? response.value.trim() : ""; if (!cwd) { setRelocationError("Path can't be empty"); return; } const session = relocatingSession; setRelocationError(undefined); setRelocatingSession(undefined); void transport.relocateSession(session.path, cwd).then(() => transport.command({ type: "switch_session", sessionPath: session.path })).then(() => refresh()).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }} />}
  </div>;
}
