import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bug, FolderGit2, GitBranch, MessageSquare, Plus, Settings } from "lucide-react";
import { ChatView } from "./components/ChatView";
import { IconButton } from "./components/IconButton";
import { SessionPanel, type SessionAction } from "./components/SessionPanel";
import { SettingsView } from "./components/SettingsView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { TerminalView } from "./components/TerminalView";
import { ProjectDialog } from "./components/ProjectDialog";
import { SplitChatPane } from "./components/SplitChatPane";
import { defaultSettings } from "./defaults";
import { keybindDefinitions, matchesShortcut } from "./lib/keybindings";
import { findReplaceableAbortedTurn } from "./lib/abortedTurn";
import { NativeTransport } from "./lib/nativeTransport";
import { SessionRuntimePool, useTurnDiffs } from "./lib/sessionRuntimePool";
import { useChatSession } from "./lib/useChatSession";
import { decodeOrchestrationValue, encodeOrchestrationValue, ORCHESTRATION_STATUS_KEY } from "./lib/orchestrationProtocol";
import { appendTerminalOutput as retainTerminalOutput, TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import type { AgentState, AppSettings, ChatMessage, CodexUsage, ExtensionUiRequest, ImageAttachment, Model, OrchestrationCapability, OrchestrationConfig, PromptContextInfo, RpcEvent, SessionSummary } from "./types";
import { branchMessages, type PiEntry } from "./lib/messages";

const staleExtensionContext = "This extension ctx is stale after session replacement or reload.";
type TerminalTabState = { id: string; output: string; outputEnd: number; started: boolean; exited?: boolean };
type SessionTerminals = { activeId: string; tabs: TerminalTabState[] };
type QueuedTerminalOutput = { data: string; length: number };
type BtwRequest = { requestId: string; task: string; forkFrom: string };
type SplitPaneState = { session: SessionSummary; btw?: BtwRequest };
const BTW_REQUEST_TITLE = "__pi_desktop_btw__";
const PROMPT_CONTEXT_STATUS_KEY = "pi-desktop-prompt-context";
const initialTerminals = (sessionId: string): SessionTerminals => { const id = `terminal-${sessionId}-1`; return { activeId: id, tabs: [{ id, output: "", outputEnd: 0, started: false }] }; };

function appendTerminalOutputs(current: Record<string, SessionTerminals>, chunks: Map<string, QueuedTerminalOutput>) {
  return Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => {
    const chunk = chunks.get(terminal.id);
    return chunk ? { ...terminal, ...retainTerminalOutput(terminal.output, terminal.outputEnd, chunk.data, chunk.length) } : terminal;
  }) }]));
}

function selectedProjectCwd(cwd?: string) {
  if (!cwd || /[\\/]pi-desktop[\\/]tmp[\\/][^\\/]+[\\/]?$/.test(cwd)) return undefined;
  return cwd;
}

export function formatCodexReset(resetAt: number, now = Date.now()) {
  const remaining = Math.max(0, resetAt * 1000 - now);
  if (remaining === 0) return "now";
  const day = 24 * 60 * 60 * 1000;
  if (remaining > day) return `${Math.ceil(remaining / day)}d`;
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ""}` : `${Math.max(1, minutes)}m`;
}

export default function App() {
  const runtimePool = useMemo(() => new SessionRuntimePool(), []); const [transport, setTransport] = useState(() => { const initial = runtimePool.create(); runtimePool.activate(initial); return initial; }); const [view, setView] = useState<"chat" | "settings">("chat");
  const runningSessions = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.runningSessions());
  const unseenSessions = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.unseenSessions());
  const gitDiffs = useTurnDiffs(runtimePool, transport);
  const sessionRuntime = useChatSession(transport); const { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh: refreshSession, handleEvent, discardPendingUpdates } = sessionRuntime;
  const [sessions, setSessions] = useState<SessionSummary[]>([]); const [settings, setSettings] = useState<AppSettings>(defaultSettings); const [orchestration, setOrchestration] = useState<OrchestrationCapability>();
  const sessionIndexRequest = useRef<Promise<void> | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(true); const [query, setQuery] = useState(""); const [connected, setConnected] = useState(false); const [error, setError] = useState<string>();
  const [activeHostId, setActiveHostId] = useState("local");
  const [activeCwd, setActiveCwd] = useState<string>();
  const [activeBranch, setActiveBranch] = useState<string>();
  const activeHostIdRef = useRef(activeHostId); activeHostIdRef.current = activeHostId;
  const [codexUsage, setCodexUsage] = useState<CodexUsage>();
  const [, setUsageClock] = useState(0);
  const [dialog, setDialog] = useState<ExtensionUiRequest>(); const [notice, setNotice] = useState<{ title: string; message: string }>();
  const [statuses, setStatuses] = useState<Record<string, string>>({}); const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [promptContext, setPromptContext] = useState<PromptContextInfo>();
  const [renameSession, setRenameSession] = useState<SessionSummary>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [relocatingSession, setRelocatingSession] = useState<SessionSummary>(); const [relocationError, setRelocationError] = useState<string>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [splitPane, setSplitPane] = useState<SplitPaneState>();
  const [terminalsBySession, setTerminalsBySession] = useState<Record<string, SessionTerminals>>({});
  const queuedTerminalOutput = useRef(new Map<string, QueuedTerminalOutput>()); const terminalOutputFrame = useRef<number | undefined>(undefined);
  const terminalSessionId = `${activeHostId}:${state.sessionId || "new-session"}`;
  const splitSessionId = splitPane ? `${splitPane.session.hostId ?? "local"}:${splitPane.session.id}` : "";
  const composerDraft = composerDrafts[terminalSessionId] ?? "";
  const splitComposerDraft = composerDrafts[splitSessionId] ?? "";
  const sessionTerminals = terminalsBySession[terminalSessionId] ?? initialTerminals(terminalSessionId);
  const activeTerminal = sessionTerminals.tabs.find((terminal) => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];

  const flushTerminalOutput = useCallback(() => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();
    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  }, []);
  const queueTerminalOutput = useCallback((terminalId: string, data: string) => {
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });
    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = requestAnimationFrame(flushTerminalOutput);
  }, [flushTerminalOutput]);

  useEffect(() => { void transport.loadCodexUsage().then(setCodexUsage).catch(() => undefined); }, [transport]);
  useEffect(() => { setPromptContext(undefined); }, [transport]);
  useEffect(() => {
    let cancelled = false;
    void transport.gitBranch().then((branch) => { if (!cancelled) setActiveBranch(branch ?? undefined); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [transport]);
  useEffect(() => {
    if (!codexUsage?.resetAt) return;
    const timer = window.setInterval(() => setUsageClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [codexUsage?.resetAt]);


  const syncSessionIndex = useCallback(() => {
    if (!sessionIndexRequest.current) sessionIndexRequest.current = transport.listSessions().then((nextSessions) => {
      setSessions(nextSessions);
      setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId && (session.hostId ?? "local") === activeHostIdRef.current);
        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch(() => undefined).finally(() => { sessionIndexRequest.current = undefined; });
    return sessionIndexRequest.current;
  }, [transport]);

  const refresh = useCallback(async (hostId?: string) => {
    void syncSessionIndex(); const [nextState, nextSettings] = await Promise.all([refreshSession(), transport.loadSettings()]); runtimePool.bind(hostId ?? transport.currentHostId(), nextState.sessionId, transport); setSettings(nextSettings); return nextSettings;
  }, [refreshSession, runtimePool, syncSessionIndex, transport]);

  const configureRuntime = useCallback((value: AppSettings) => Promise.all([
    transport.command({ type: "set_auto_compaction", enabled: value.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: value.autoRetry })
  ]), [transport]);
  const resolveHomeDirectory = useCallback((hostId: string) => transport.homeDirectory(hostId), [transport]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      if (event.type === "terminal_output") queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
      if (event.type === "terminal_exit") setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal) }])));
      if (event.type === "extension_error") { const message = String(event.error ?? "An extension failed"); if (!message.startsWith(staleExtensionContext)) setNotice({ title: "Extension error", message }); }
      if (event.type === "extension_ui_request") { const request = event as unknown as ExtensionUiRequest;
        if (request.method === "notify") setNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "Pi extension", message: request.message || "Notification" });
        else if (request.method === "input" && request.title === BTW_REQUEST_TITLE) {
          try {
            const payload = JSON.parse(request.placeholder || "{}") as { task?: unknown; sessionFile?: unknown; cwd?: unknown };
            if (typeof payload.task !== "string" || !payload.task.trim() || typeof payload.sessionFile !== "string" || !payload.sessionFile) throw new Error("Invalid /btw branch request");
            const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ".";
            setSplitPane({
              session: { id: `btw-${request.id}`, path: "", name: "BTW", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: payload.task, messageCount: 0, apiCost: 0, hostId: activeHostIdRef.current },
              btw: { requestId: request.id, task: payload.task, forkFrom: payload.sessionFile },
            });
          } catch (reason) {
            void transport.command({ type: "extension_ui_response", id: request.id, cancelled: true });
            setNotice({ title: "Could not start /btw", message: reason instanceof Error ? reason.message : String(reason) });
          }
        }
        else if (request.method === "setStatus" && request.statusKey === ORCHESTRATION_STATUS_KEY) { try {
          const capability = request.statusText?.startsWith("json:") ? decodeOrchestrationValue<OrchestrationCapability>(request.statusText.slice(5)) : undefined;
          setOrchestration(capability);
          if (capability) { const sequence = capability.config.sequences.find((item) => item.name === capability.active); const agent = capability.config.agents.find((item) => item.name === (capability.currentAgent ?? sequence?.agents[0] ?? capability.active)); if (agent) setState((current) => { const [provider, ...modelId] = agent.model.split("/"); return { ...current, ...(agent.model && modelId.length ? { model: { provider, id: modelId.join("/"), name: modelId.join("/") } } : {}), ...(agent.effort ? { thinkingLevel: agent.effort } : {}) }; }); }
        } catch { setOrchestration(undefined); } }
        else if (request.method === "setStatus" && request.statusKey === PROMPT_CONTEXT_STATUS_KEY) { try { setPromptContext(request.statusText?.startsWith("json:") ? JSON.parse(request.statusText.slice(5)) as PromptContextInfo : undefined); } catch { setPromptContext(undefined); } }
        else if (request.method === "setStatus" && request.statusKey) setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
        else if (request.method === "setWidget" && request.widgetKey) setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = request.widgetLines; else delete next[request.widgetKey!]; return next; });
        else if (request.method === "setTitle" && request.title) document.title = request.title;
        else if (request.method === "set_editor_text") window.dispatchEvent(new CustomEvent("pi:set-editor-text", { detail: request.text || "" }));
        else setDialog(request);
      }
      if (event.type === "session_switched") void refresh();
      if (event.type === "session_info_changed") void refresh();
      if (event.type === "disconnected") setOrchestration(undefined);
    });
    transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => { if (!cancelled) { setError(undefined); setConnected(true); } }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; unsubscribe(); if (terminalOutputFrame.current !== undefined) cancelAnimationFrame(terminalOutputFrame.current); terminalOutputFrame.current = undefined; queuedTerminalOutput.current.clear(); };
  }, [configureRuntime, handleEvent, queueTerminalOutput, refresh, transport]);

  useEffect(() => { const shutdown = () => { void runtimePool.disconnectAll(); }; window.addEventListener("beforeunload", shutdown); return () => window.removeEventListener("beforeunload", shutdown); }, [runtimePool]);
  useEffect(() => { runtimePool.activate(view === "chat" ? transport : undefined); }, [runtimePool, transport, view]);

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => void syncSessionIndex(), settings.hosts.length ? 5000 : 1500);
    return () => window.clearInterval(interval);
  }, [connected, settings.hosts.length, syncSessionIndex]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (behavior) { await transport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); setState((current) => ({ ...current, pendingMessageCount: current.pendingMessageCount + 1 })); return; }
    const abandoned = findReplaceableAbortedTurn(messages);
    if (abandoned) {
      let oldSessionPath = state.sessionFile;
      if (!oldSessionPath) oldSessionPath = (await transport.command<AgentState>({ type: "get_state" })).sessionFile;
      if (!oldSessionPath) throw new Error("Cannot replace an aborted turn before the session has been saved");
      let entryId = abandoned.user.entryId;
      if (!entryId) { const response = await transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); entryId = findReplaceableAbortedTurn(branchMessages(response.entries, response.leafId))?.user.entryId; }
      if (!entryId) throw new Error("Cannot find the abandoned turn in the saved session");
      const fork = await transport.command<{ cancelled?: boolean }>({ type: "fork", entryId });
      if (fork.cancelled) return;
      await transport.deleteSession(oldSessionPath, activeHostId);
      setSessions((current) => current.filter((session) => session.path !== oldSessionPath || (session.hostId ?? "local") !== activeHostId));
      await refresh();
    }
    await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
  };
  const closeSplitPane = () => {
    if (splitPane?.btw) void transport.command({ type: "extension_ui_response", id: splitPane.btw.requestId, cancelled: true });
    setSplitPane(undefined);
  };
  const branch = async (message: ChatMessage) => { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (!user) return; await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); };
  const newSession = async () => { const hostId = activeHostIdRef.current; const projectCwd = selectedProjectCwd(activeCwd); setView("chat"); closeSplitPane(); setConnected(false); setOrchestration(undefined); discardPendingUpdates(); setMessages([]); const nextTransport = runtimePool.create(projectCwd ? { cwd: projectCwd, hostId } : { hostId }); try { if (projectCwd) setActiveCwd(projectCwd); else setActiveCwd(await nextTransport.prepareTemporaryChat(hostId)); setActiveHostId(hostId); runtimePool.activate(nextTransport); setTransport(nextTransport); } catch (reason) { setConnected(true); setError(reason instanceof Error ? reason.message : String(reason)); } };
  const selectSession = (session: SessionSummary) => {
    const hostId = session.hostId ?? "local"; if (session.id === state.sessionId && hostId === activeHostId) return transport;
    if (splitPane?.session.id === session.id && (splitPane.session.hostId ?? "local") === hostId) closeSplitPane();
    if (session.cwdExists === false) { setRelocationError(undefined); setRelocatingSession(session); return undefined; }
    const nextTransport = runtimePool.forSession(session);
    discardPendingUpdates(); setView("chat"); setConnected(false); setOrchestration(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); setMessages([]); setState((value) => ({ ...value, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, isStreaming: false, activity: undefined })); runtimePool.activate(nextTransport); setTransport(nextTransport); return nextTransport;
  };
  const setModel = async (model: Model) => { await transport.command({ type: "set_model", provider: model.provider, modelId: model.id }); await refreshSession(); };
  const setThinking = async (level: string) => { await transport.command({ type: "set_thinking_level", level }); setState((current) => ({ ...current, thinkingLevel: level })); };
  const saveSettings = async (value: AppSettings, nextConfig?: OrchestrationConfig) => { const next = { ...value, debugMode: settings.debugMode }; if (nextConfig) await transport.command({ type: "prompt", message: `/pi-orchestration-config ${encodeOrchestrationValue(nextConfig)}` }); await transport.saveSettings(next); await configureRuntime(next); setSettings(next); if (activeHostId !== "local" && !next.hosts.some((host) => host.id === activeHostId)) setActiveHostId("local"); await refresh(); };
  const setAgent = async (name: string) => { await transport.command({ type: "prompt", message: `/pi-orchestration-use ${encodeOrchestrationValue(name)}` }); };
  const openProject = async (cwd: string, hostId: string) => { setProjectOpen(false); closeSplitPane(); setConnected(false); setOrchestration(undefined); discardPendingUpdates(); setMessages([]); setActiveHostId(hostId); setActiveCwd(cwd); setView("chat"); const nextTransport = runtimePool.create({ cwd, hostId }); runtimePool.activate(nextTransport); setTransport(nextTransport); };
  const chooseChatProject = () => setProjectOpen(true);
  const openSplitPane = (session: SessionSummary) => { closeSplitPane(); setSplitPane({ session }); };
  const sessionAction = async (session: SessionSummary, action: SessionAction) => {
    if (action === "split") { openSplitPane(session); return; }
    if (action === "open-directory") {
      try { await transport.openProjectDirectory(session.cwd, session.hostId); }
      catch (reason) { setNotice({ title: "Could not open project directory", message: reason instanceof Error ? reason.message : String(reason) }); }
      return;
    }
    if (action === "archive") {
      try {
        const archivedTerminalSessionId = `${session.hostId ?? "local"}:${session.id}`;
        const terminalState = terminalsBySession[archivedTerminalSessionId];
        if (session.id === state.sessionId && (session.hostId ?? "local") === activeHostId) { await transport.command({ type: "new_session" }); await refresh(); }
        else await runtimePool.remove(session);
        await transport.archiveSession(session.path, session.hostId, terminalState);
        setTerminalsBySession((current) => { const next = { ...current }; delete next[archivedTerminalSessionId]; return next; });
        if (archivedTerminalSessionId === terminalSessionId) setTerminalOpen(false);
        await refresh();
      } catch (reason) { setNotice({ title: "Could not archive conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
      return;
    }
    if (action === "logs") {
      try { await transport.openLogViewer(session.path, session.hostId); }
      catch (reason) { setNotice({ title: "Could not open request viewer", message: reason instanceof Error ? reason.message : String(reason) }); }
      return;
    }
    const selectedTransport = selectSession(session); if (!selectedTransport) return;
    if (action === "rename") { setRenameSession(session); return; }
    if (action === "clone") { await selectedTransport.connect(); await selectedTransport.command({ type: "clone" }); await syncSessionIndex(); }
  };
  const startTerminal = async (terminalId: string, cols: number, rows: number) => {
    setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); return { ...current, [terminalSessionId]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = activeCwd ?? sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId)?.cwd;
    if (!cwd) { queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n"); return; }
    try { await transport.startTerminal(terminalId, cwd, cols, rows); } catch (reason) { queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); }
  };
  const addTerminal = () => setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); const id = `terminal-${terminalSessionId}-${Date.now()}`; return { ...current, [terminalSessionId]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; });
  const selectTerminal = (terminalId: string) => setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); return { ...current, [terminalSessionId]: { ...session, activeId: terminalId } }; });
  const deleteTerminal = () => {
    const terminalId = activeTerminal.id; const closingLast = sessionTerminals.tabs.length === 1;
    void transport.closeTerminal(terminalId).catch(() => undefined);
    if (closingLast) setTerminalOpen(false);
    setTerminalsBySession((current) => { const session = current[terminalSessionId] ?? initialTerminals(terminalSessionId); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current }; if (!tabs.length) delete next[terminalSessionId]; else next[terminalSessionId] = { activeId: tabs[0].id, tabs }; return next; });
  };
  const setComposerDraft = (value: string) => setComposerDrafts((current) => { if (value) return { ...current, [terminalSessionId]: value }; const next = { ...current }; delete next[terminalSessionId]; return next; });
  const setSplitComposerDraft = (value: string) => setComposerDrafts((current) => { if (value) return { ...current, [splitSessionId]: value }; const next = { ...current }; delete next[splitSessionId]; return next; });
  const toggleTerminal = () => { setView("chat"); setTerminalOpen((open) => !open); };
  const toggleDebugMode = useCallback(() => {
    setSettings((current) => {
      const next = { ...current, debugMode: !current.debugMode };
      void transport.saveSettings(next, false).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return next;
    });
  }, [transport]);

  useEffect(() => {
    const handleKeybind = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const binding = keybindDefinitions.find((item) => matchesShortcut(event, settings.keybindings[item.action]));
      if (!binding) return;
      event.preventDefault();
      if (binding.action === "newConversation") { void newSession(); return; }
      if (binding.action === "toggleConversations") { setView("chat"); setPanelOpen((open) => !open); return; }
      if (binding.action === "toggleTerminal") { toggleTerminal(); return; }
      if (binding.action === "toggleDebugMode") { toggleDebugMode(); return; }
      if (binding.action === "openSettings") { setView("settings"); return; }
      setView("chat"); window.setTimeout(() => window.dispatchEvent(new Event("pi:focus-composer")), 0);
    };
    window.addEventListener("keydown", handleKeybind);
    return () => window.removeEventListener("keydown", handleKeybind);
  }, [settings.keybindings, toggleDebugMode]);

  return <div className="app dark">
    {import.meta.env.MODE === "e2e" && <div className="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /><button aria-label="E2E refresh sessions" onClick={() => void syncSessionIndex()} /></div>}
    <aside className="icon-rail">{activeBranch && <div className="rail-branch" title={activeBranch}><GitBranch size={13} /><span>{activeBranch}</span></div>}<nav><IconButton label="New conversation" onClick={newSession}><Plus size={19} /></IconButton><IconButton label="Conversations" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><MessageSquare size={18} /></IconButton><IconButton label="New project" onClick={() => setProjectOpen(true)}><FolderGit2 size={18} /></IconButton><IconButton label={settings.debugMode ? "Disable debug mode" : "Enable debug mode"} className={settings.debugMode ? "active" : ""} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label="Settings" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={19} /></IconButton></nav>{view === "chat" && panelOpen && <SessionPanel sessions={sessions} activeId={state.sessionId} activeHostId={activeHostId} runningSessions={runningSessions} unseenSessions={unseenSessions} query={query} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} />}<div className="rail-bottom">{codexUsage !== undefined && <span className="codex-usage" aria-label="Codex usage remaining" title="Codex usage remaining">{codexUsage.remainingPercent}% left{codexUsage.resetAt ? ` · ${formatCodexReset(codexUsage.resetAt)}` : ""}</span>}</div></aside>
    {view === "chat" ? <div className="chat-workspace"><div className={`chat-panes ${splitPane ? "split" : ""}`}><ChatView state={state} messages={messages} gitDiffs={gitDiffs} promptContext={promptContext} debug={settings.debugMode} agents={orchestration?.config.agents ?? []} sequences={orchestration?.config.sequences ?? []} activeAgent={orchestration?.active} dictionaries={settings.dictionaries.filter((item) => settings.activeDictionaryIds.includes(item.id))} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={Object.values(widgets).flat()} statuses={Object.values(statuses)} projectCwd={selectedProjectCwd(activeCwd)} draft={composerDraft} onDraftChange={setComposerDraft} onSend={send} onAbort={() => transport.command({ type: "abort" })} onOpenTerminal={() => setTerminalOpen(true)} onOpenProject={chooseChatProject} onBranch={branch} onAgent={setAgent} onModel={setModel} onThinking={setThinking} />{splitPane && <SplitChatPane key={splitSessionId} runtimePool={runtimePool} session={splitPane.session} settings={settings} draft={splitComposerDraft} onDraftChange={setSplitComposerDraft} forkFrom={splitPane.btw?.forkFrom} initialPrompt={splitPane.btw?.task} onClose={closeSplitPane} onComplete={(answer) => { const requestId = splitPane.btw?.requestId; setSplitPane(undefined); if (requestId) void transport.command({ type: "extension_ui_response", id: requestId, value: answer }); }} onFailure={(message) => { const requestId = splitPane.btw?.requestId; setSplitPane(undefined); if (requestId) void transport.command({ type: "extension_ui_response", id: requestId, cancelled: true }); setNotice({ title: "/btw failed", message }); }} />}</div>{terminalOpen && <TerminalView key={`${terminalSessionId}:${activeTerminal.id}`} cwd={activeCwd ?? sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId)?.cwd} terminals={sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={activeTerminal.id} output={activeTerminal.output} outputEnd={activeTerminal.outputEnd} exited={activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={(data) => { void transport.writeTerminal(activeTerminal.id, data).catch((reason) => queueTerminalOutput(activeTerminal.id, `\r\nTerminal input failed: ${String(reason)}\r\n`)); }} onResize={(cols, rows) => { void transport.resizeTerminal(activeTerminal.id, cols, rows).catch(() => undefined); }} onDelete={deleteTerminal} onClose={() => setTerminalOpen(false)} />}</div> : <SettingsView settings={settings} orchestration={orchestration?.config} models={models} thinkingLevels={thinkingLevels} onSave={saveSettings} />}
    {error && <div className="error-toast"><strong>Pi could not connect</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
    {notice && <div className="error-toast"><strong>{notice.title}</strong><span>{notice.message}</span><button onClick={() => setNotice(undefined)}>×</button></div>}
    {dialog && <ExtensionDialog request={dialog} onRespond={(response) => { void transport.command({ type: "extension_ui_response", id: dialog.id, ...response }); setDialog(undefined); }} />}
    {projectOpen && <ProjectDialog initialPath="" hosts={settings.hosts} initialHostId={activeHostId} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => hostId === "local" ? transport.selectProjectDirectory(currentPath || undefined) : transport.listDirectories(hostId, currentPath || undefined)} onOpen={(cwd, hostId) => void openProject(cwd, hostId)} onCancel={() => setProjectOpen(false)} />}
    {renameSession && <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: renameSession.name }} onRespond={(response) => { setRenameSession(undefined); if (typeof response.value === "string" && response.value.trim()) { const name = response.value.trim(); void transport.command({ type: "set_session_name", name }).then(() => { setState((current) => ({ ...current, sessionName: name })); void refresh(); }); } }} />}
    {relocatingSession && <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${relocatingSession.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${relocatingSession.cwd}. Enter its new location to open this conversation.`, error: relocationError, placeholder: "Replacement project directory", prefill: sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId && session.cwdExists !== false)?.cwd || "" }} onRespond={(response) => { if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; } const cwd = typeof response.value === "string" ? response.value.trim() : ""; if (!cwd) { setRelocationError("Path can't be empty"); return; } const session = relocatingSession; setRelocationError(undefined); setRelocatingSession(undefined); void transport.relocateSession(session.path, cwd, session.hostId).then(() => { selectSession({ ...session, cwd, cwdExists: true }); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }} />}
  </div>;
}
