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
import type { AgentState, AppSettings, ChatMessage, CodexUsage, ComposerUpload, ExtensionUiRequest, ImageAttachment, Model, OrchestrationCapability, OrchestrationConfig, PromptContextInfo, RpcEvent, SessionSummary } from "./types";
import { branchMessages, type PiEntry } from "./lib/messages";

const staleExtensionContext = "This extension ctx is stale after session replacement or reload.";
type TerminalTabState = { id: string; output: string; outputEnd: number; snapshot?: string; snapshotEnd?: number; started: boolean; exited?: boolean };
type SessionTerminals = { activeId: string; tabs: TerminalTabState[] };
type QueuedTerminalOutput = { data: string; length: number };
type BtwRequest = { task: string; forkFrom: string; requestId: string };
type SplitPaneState = { session: SessionSummary; btw?: BtwRequest };
type OwnedExtensionDialog = { request: ExtensionUiRequest; transport: NativeTransport };
const BTW_REQUEST_TITLE = "__pi_desktop_btw__";
const PROMPT_CONTEXT_STATUS_KEY = "pi-desktop-prompt-context";
const MCP_STATUS_KEY = "pi-desktop-mcp-status";
const MAX_TERMINALS = 8;
const initialTerminals = (sessionId: string): SessionTerminals => { const id = `terminal-${sessionId}-1`; return { activeId: id, tabs: [{ id, output: "", outputEnd: 0, started: false }] }; };

function appendTerminalOutputs(current: Record<string, SessionTerminals>, chunks: Map<string, QueuedTerminalOutput>) {
  return Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => {
    const chunk = chunks.get(terminal.id);
    return chunk ? { ...terminal, ...retainTerminalOutput(terminal.output, terminal.outputEnd, chunk.data, chunk.length) } : terminal;
  }) }]));
}

function selectedProjectCwd(cwd: string | undefined, temporary: boolean) { return !cwd || temporary ? undefined : cwd; }

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
  const activeTransportRef = useRef(transport); activeTransportRef.current = transport;
  const initialConversationKey = useRef(`local:draft-${crypto.randomUUID()}`);
  const [activeConversationKey, setActiveConversationKey] = useState(initialConversationKey.current);
  const activeConversationKeyRef = useRef(activeConversationKey); activeConversationKeyRef.current = activeConversationKey;
  const transportConversationKeys = useRef(new Map<NativeTransport, string>([[transport, initialConversationKey.current]]));
  const runningSessions = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.runningSessions());
  const unseenSessions = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.unseenSessions());
  const gitDiffs = useTurnDiffs(runtimePool, transport);
  const sessionRuntime = useChatSession(transport); const { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh: refreshSession, handleEvent, discardPendingUpdates } = sessionRuntime;
  const [sessions, setSessions] = useState<SessionSummary[]>([]); const [settings, setSettings] = useState<AppSettings>(defaultSettings); const [orchestration, setOrchestration] = useState<OrchestrationCapability>();
  const [settingsDirty, setSettingsDirty] = useState(false);
  const sessionIndexRequest = useRef<Promise<void> | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(true); const [query, setQuery] = useState(""); const [connected, setConnected] = useState(false); const connectionReadyRef = useRef(connected); connectionReadyRef.current = connected; const updateConnected = (value: boolean) => { connectionReadyRef.current = value; setConnected(value); }; const [error, setError] = useState<string>();
  const [activeHostId, setActiveHostId] = useState("local");
  const [activeCwd, setActiveCwd] = useState<string>();
  const [activeBranch, setActiveBranch] = useState<string>();
  const activeHostIdRef = useRef(activeHostId); activeHostIdRef.current = activeHostId;
  const [codexUsage, setCodexUsage] = useState<CodexUsage>();
  const [, setUsageClock] = useState(0);
  const [dialogs, setDialogs] = useState<OwnedExtensionDialog[]>([]); const [notice, setNotice] = useState<{ title: string; message: string }>();
  const [statuses, setStatuses] = useState<Record<string, string>>({}); const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [extensionOwner, setExtensionOwner] = useState(transport);
  const [promptContext, setPromptContext] = useState<PromptContextInfo>();
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, { status: "connected" | "stopped" | "error"; error?: string }>>({});
  const [renameSession, setRenameSession] = useState<SessionSummary>();
  const [projectOpen, setProjectOpen] = useState(false);
  const projectOpenRef = useRef(projectOpen); projectOpenRef.current = projectOpen;
  const [relocatingSession, setRelocatingSession] = useState<SessionSummary>(); const [relocationError, setRelocationError] = useState<string>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [uploadsByTransport, setUploadsByTransport] = useState<Map<NativeTransport, ComposerUpload[]>>(() => new Map());
  const newSessionPending = useRef(false);
  const [splitPane, setSplitPane] = useState<SplitPaneState>();
  const [mainComposerFocusRequest, setMainComposerFocusRequest] = useState(0);
  const [splitComposerFocusRequest, setSplitComposerFocusRequest] = useState(0);
  const [activePane, setActivePane] = useState<"main" | "split">("main");
  const pendingBtwRequest = useRef<{ id: string; transport: NativeTransport } | undefined>(undefined);
  const [terminalsBySession, setTerminalsBySession] = useState<Record<string, SessionTerminals>>({});
  const queuedTerminalOutput = useRef(new Map<string, QueuedTerminalOutput>()); const terminalOutputFrame = useRef<number | undefined>(undefined);
  const terminalSessionId = activeConversationKey;
  const terminalSessionIdRef = useRef(terminalSessionId); terminalSessionIdRef.current = terminalSessionId;
  const splitSessionId = splitPane ? `${splitPane.session.hostId ?? "local"}:${splitPane.session.id}` : "";
  const composerDraft = composerDrafts[terminalSessionId] ?? "";
  const composerUploads = uploadsByTransport.get(transport) ?? [];
  const splitComposerDraft = composerDrafts[splitSessionId] ?? "";
  const sessionTerminals = terminalsBySession[terminalSessionId] ?? initialTerminals(terminalSessionId);
  const activeTerminal = sessionTerminals.tabs.find((terminal) => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];
  const activateConversationKey = (key: string) => { activeConversationKeyRef.current = key; setActiveConversationKey(key); };

  const flushTerminalOutput = useCallback(() => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();
    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  }, []);
  const queueTerminalOutput = useCallback((terminalId: string, data: string) => {
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });
    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = window.setTimeout(flushTerminalOutput, 0);
  }, [flushTerminalOutput]);

  useEffect(() => { let cancelled = false; void transport.loadCodexUsage().then((usage) => { if (!cancelled) setCodexUsage(usage); }).catch(() => undefined); return () => { cancelled = true; }; }, []);
  useEffect(() => { newSessionPending.current = false; }, [transport]);
  useEffect(() => { setPromptContext(undefined); }, [transport]);
  useEffect(() => {
    const previousKey = activeConversationKeyRef.current;
    if (!state.sessionId || !previousKey.includes(":draft-")) return;
    const canonicalKey = `${activeHostId}:${state.sessionId}`;
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    transportConversationKeys.current.set(transport, canonicalKey); activateConversationKey(canonicalKey);
  }, [activeHostId, state.sessionId, transport]);
  useEffect(() => {
    document.title = "Pi";
    setStatuses({}); setWidgets({});
    setDialogs((current) => {
      for (const dialog of current) if (dialog.transport !== transport) void dialog.transport.command({ type: "extension_ui_response", id: dialog.request.id, cancelled: true }).catch(() => undefined);
      return current.filter((dialog) => dialog.transport === transport);
    });
  }, [transport]);
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

  const configureRuntime = useCallback(async (value: AppSettings) => {
    const [{ models: availableModels }] = await Promise.all([
      transport.command<{ models: Model[] }>({ type: "get_available_models" }),
      transport.command({ type: "set_auto_compaction", enabled: value.autoCompaction }),
      transport.command({ type: "set_auto_retry", enabled: value.autoRetry }),
    ]);
    const defaultModel = availableModels.find((model) => `${model.provider}/${model.id}` === value.defaultModel);
    if (!defaultModel) throw new Error(`Default model is unavailable: ${value.defaultModel}`);
    await transport.command({ type: "set_model", provider: defaultModel.provider, modelId: defaultModel.id });
  }, [transport]);
  const resolveHomeDirectory = useCallback((hostId: string) => transport.homeDirectory(hostId), [transport]);

  useEffect(() => {
    let cancelled = false; let reconnecting = false;
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      if (event.type === "terminal_output") queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
      if (event.type === "terminal_exit") setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal) }])));
      if (event.type === "extension_error") { const message = String(event.error ?? "An extension failed"); if (!message.startsWith(staleExtensionContext)) setNotice({ title: "Extension error", message }); }
      if (event.type === "extension_ui_request") { const request = event as unknown as ExtensionUiRequest;
        if (transport !== activeTransportRef.current) { if (["input", "editor", "select", "confirm"].includes(request.method)) void transport.command({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => undefined); return; }
        if (request.method === "notify") setNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "Pi extension", message: request.message || "Notification" });
        else if (request.method === "input" && request.title === BTW_REQUEST_TITLE) {
          try {
            const payload = JSON.parse(request.placeholder || "{}") as { task?: unknown; sessionFile?: unknown; cwd?: unknown };
            if (typeof payload.task !== "string" || !payload.task.trim() || typeof payload.sessionFile !== "string" || !payload.sessionFile) throw new Error("Invalid /btw branch request");
            const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ".";
            const previous = pendingBtwRequest.current;
            if (previous && previous.id !== request.id) void previous.transport.command({ type: "extension_ui_response", id: previous.id, cancelled: true }).catch(() => undefined);
            pendingBtwRequest.current = { id: request.id, transport };
            setSplitPane({
              session: { id: `btw-${request.id}`, path: "", name: "BTW", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: payload.task, messageCount: 0, apiCost: 0, hostId: activeHostIdRef.current },
              btw: { task: payload.task, forkFrom: payload.sessionFile, requestId: request.id },
            });
          } catch (reason) {
            void transport.command({ type: "extension_ui_response", id: request.id, cancelled: true });
            setNotice({ title: "Could not start /btw", message: reason instanceof Error ? reason.message : String(reason) });
          }
        }
        else if (request.method === "setStatus" && request.statusKey === ORCHESTRATION_STATUS_KEY) { setExtensionOwner(transport); try {
          const capability = request.statusText?.startsWith("json:") ? decodeOrchestrationValue<OrchestrationCapability>(request.statusText.slice(5)) : undefined;
          setOrchestration(capability);
          if (capability) void refreshSession().catch(() => undefined);
        } catch { setOrchestration(undefined); } }
        else if (request.method === "setStatus" && request.statusKey === PROMPT_CONTEXT_STATUS_KEY) { setExtensionOwner(transport); try { setPromptContext(request.statusText?.startsWith("json:") ? JSON.parse(request.statusText.slice(5)) as PromptContextInfo : undefined); } catch { setPromptContext(undefined); } }
        else if (request.method === "setStatus" && request.statusKey === MCP_STATUS_KEY) { setExtensionOwner(transport); try { const values = request.statusText?.startsWith("json:") ? JSON.parse(request.statusText.slice(5)) as Array<{ id: string; status: "connected" | "stopped" | "error"; error?: string }> : []; setMcpStatuses(Object.fromEntries(values.map((value) => [value.id, { status: value.status, error: value.error }]))); } catch { setMcpStatuses({}); } }
        else if (request.method === "setStatus" && request.statusKey) { setExtensionOwner(transport); setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; }); }
        else if (request.method === "setWidget" && request.widgetKey) { setExtensionOwner(transport); setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = request.widgetLines; else delete next[request.widgetKey!]; return next; }); }
        else if (request.method === "setTitle") document.title = request.title || "Pi";
        else if (request.method === "set_editor_text") { setComposerDrafts((current) => { const key = transportConversationKeys.current.get(transport) ?? terminalSessionIdRef.current; const next = { ...current }; if (request.text) next[key] = request.text; else delete next[key]; return next; }); setActivePane("main"); setMainComposerFocusRequest((value) => value + 1); }
        else setDialogs((current) => [...current, { request, transport }]);
      }
      if (event.type === "session_switched") void refresh();
      if (event.type === "session_info_changed") void refresh();
      if (event.type === "disconnected") {
        setOrchestration(undefined); setMcpStatuses({}); updateConnected(false);
        if (reconnecting) return; reconnecting = true;
        window.setTimeout(() => {
          if (cancelled) return; const diagnostic = transport.lastDiagnostic();
          void transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { if (!cancelled) { setError(undefined); updateConnected(true); } }).catch((reason: unknown) => { if (!cancelled) { const message = reason instanceof Error ? reason.message : String(reason); setError(diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message); } }).finally(() => { reconnecting = false; });
        }, 50);
      }
    });
    transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { if (!cancelled) { setError(undefined); updateConnected(true); } }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; unsubscribe(); if (terminalOutputFrame.current !== undefined) window.clearTimeout(terminalOutputFrame.current); terminalOutputFrame.current = undefined; queuedTerminalOutput.current.clear(); };
  }, [configureRuntime, handleEvent, queueTerminalOutput, refresh, refreshSession, transport]);

  useEffect(() => { const shutdown = () => { void runtimePool.disconnectAll(); }; window.addEventListener("pagehide", shutdown); return () => window.removeEventListener("pagehide", shutdown); }, [runtimePool]);
  useEffect(() => { if (!settingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [settingsDirty]);
  useEffect(() => { runtimePool.activate(view === "chat" ? transport : undefined); }, [runtimePool, transport, view]);

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => void syncSessionIndex(), settings.hosts.length ? 5000 : 1500);
    return () => window.clearInterval(interval);
  }, [connected, settings.hosts.length, syncSessionIndex]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (!connectionReadyRef.current) throw new Error("Pi is still connecting");
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
      if (fork.cancelled) return false;
      await transport.deleteSession(oldSessionPath, activeHostId);
      setSessions((current) => current.filter((session) => session.path !== oldSessionPath || (session.hostId ?? "local") !== activeHostId));
      await refresh();
    }
    await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
    return true;
  };
  const respondToBtw = (requestId: string, response: { value?: string; cancelled?: boolean }) => {
    const pending = pendingBtwRequest.current; if (!pending || pending.id !== requestId) return;
    pendingBtwRequest.current = undefined;
    void pending.transport.command({ type: "extension_ui_response", id: requestId, ...response }).catch((reason) => setNotice({ title: "Could not finish /btw request", message: reason instanceof Error ? reason.message : String(reason) }));
  };
  const closeSplitPane = () => { if (splitPane?.btw) respondToBtw(splitPane.btw.requestId, { cancelled: true }); setSplitPane(undefined); setActivePane("main"); };
  const canLeaveSettings = () => view !== "settings" || !settingsDirty || window.confirm("Discard unsaved settings changes?");
  const setComposerUploads = (uploads: ComposerUpload[]) => setUploadsByTransport((current) => {
    const next = new Map(current);
    if (uploads.length) next.set(transport, uploads); else next.delete(transport);
    return next;
  });
  const activateTransport = (nextTransport: NativeTransport) => {
    const previousTransport = transport;
    const discardPrevious = previousTransport !== nextTransport && !state.isStreaming && state.messageCount === 0 && messages.length === 0;
    runtimePool.activate(nextTransport); setTransport(nextTransport);
    if (discardPrevious) {
      setUploadsByTransport((current) => { const next = new Map(current); next.delete(previousTransport); return next; });
      void runtimePool.release(previousTransport).finally(() => transportConversationKeys.current.delete(previousTransport));
    }
  };
  const branch = async (message: ChatMessage) => { try { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (!user) throw new Error("Could not find the message to branch from"); await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); } catch (reason) { setNotice({ title: "Could not branch conversation", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const newSession = async () => { if (newSessionPending.current || !canLeaveSettings()) return; newSessionPending.current = true; const hostId = activeHostIdRef.current; const projectCwd = selectedProjectCwd(activeCwd, transport.isTemporaryChat()); const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; activateConversationKey(conversationKey); setView("chat"); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setOrchestration(undefined); discardPendingUpdates(); setMessages([]); setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, activity: undefined, contextUsage: undefined })); const nextTransport = runtimePool.create(projectCwd ? { cwd: projectCwd, hostId } : { hostId }); transportConversationKeys.current.set(nextTransport, conversationKey); try { if (projectCwd) setActiveCwd(projectCwd); else setActiveCwd(await nextTransport.prepareTemporaryChat(hostId)); setActiveHostId(hostId); activateTransport(nextTransport); } catch (reason) { newSessionPending.current = false; transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport); updateConnected(false); setError(reason instanceof Error ? reason.message : String(reason)); } };
  const selectSession = (session: SessionSummary) => {
    const hostId = session.hostId ?? "local"; if (session.id === state.sessionId && hostId === activeHostId) return transport;
    if (splitPane?.session.id === session.id && (splitPane.session.hostId ?? "local") === hostId) closeSplitPane();
    if (session.cwdExists === false) { setRelocationError(undefined); setRelocatingSession(session); return undefined; }
    const nextTransport = runtimePool.forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setOrchestration(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); setMessages([]); setState((value) => ({ ...value, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, isStreaming: false, activity: undefined })); activateTransport(nextTransport); return nextTransport;
  };
  const setModel = async (model: Model) => { try { await transport.command({ type: "set_model", provider: model.provider, modelId: model.id }); await refreshSession(); } catch (reason) { setNotice({ title: "Could not change model", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const setThinking = async (level: string) => { try { await transport.command({ type: "set_thinking_level", level }); setState((current) => ({ ...current, thinkingLevel: level })); } catch (reason) { setNotice({ title: "Could not change thinking level", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const abortInteraction = () => { void transport.command({ type: "abort" }).catch((reason) => setNotice({ title: "Could not stop Pi", message: reason instanceof Error ? reason.message : String(reason) })); };
  const saveSettings = async (value: AppSettings, nextConfig?: OrchestrationConfig) => {
    const clean = (source: AppSettings) => ({ ...source, mcpServers: source.mcpServers.map(({ error: _error, ...server }) => ({ ...server, status: "stopped" as const })) });
    const previous = clean(settings); const previousConfig = orchestration?.config; const next = { ...clean(value), debugMode: settings.debugMode }; let settingsApplied = false; let orchestrationAttempted = false;
    try {
      await transport.saveSettings(next); settingsApplied = true; await configureRuntime(next);
      if (nextConfig) { orchestrationAttempted = true; await transport.command({ type: "prompt", message: `/pi-orchestration-config ${encodeOrchestrationValue(nextConfig)}` }); }
    } catch (reason) {
      if (orchestrationAttempted && previousConfig) await transport.command({ type: "prompt", message: `/pi-orchestration-config ${encodeOrchestrationValue(previousConfig)}` }).catch(() => undefined);
      if (settingsApplied) try { await transport.saveSettings(previous); await configureRuntime(previous); } catch { /* Keep the original failure; NativeTransport owns persistence and reconnect rollback. */ }
      throw reason;
    }
    setSettings(next); if (activeHostId !== "local" && !next.hosts.some((host) => host.id === activeHostId)) setActiveHostId("local"); void refresh().catch((reason) => setNotice({ title: "Settings saved, but the view could not refresh", message: reason instanceof Error ? reason.message : String(reason) }));
  };
  const setAgent = async (name: string) => { try { await transport.command({ type: "prompt", message: `/pi-orchestration-use ${encodeOrchestrationValue(name)}` }); } catch (reason) { setNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const openProject = async (cwd: string, hostId: string) => { if (!canLeaveSettings()) return; const validatedCwd = await transport.validateProjectDirectory(cwd, hostId); if (!projectOpenRef.current) return; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setOrchestration(undefined); discardPendingUpdates(); setMessages([]); activateConversationKey(conversationKey); setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, activity: undefined, contextUsage: undefined })); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = runtimePool.create({ cwd: validatedCwd, hostId }); transportConversationKeys.current.set(nextTransport, conversationKey); activateTransport(nextTransport); };
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
      if (!window.confirm(`Archive “${session.name}”?`)) return;
      const isActiveSession = session.id === state.sessionId && (session.hostId ?? "local") === activeHostId;
      if (isActiveSession) updateConnected(false);
      try {
        const archivedTerminalSessionId = `${session.hostId ?? "local"}:${session.id}`;
        const terminalState = terminalsBySession[archivedTerminalSessionId];
        await transport.archiveSession(session.path, session.hostId, terminalState);
        if (isActiveSession) { const conversationKey = `${activeHostId}:draft-${crypto.randomUUID()}`; transportConversationKeys.current.set(transport, conversationKey); activateConversationKey(conversationKey); await transport.command({ type: "new_session" }); await refresh(); updateConnected(true); }
        else await runtimePool.remove(session);
        setTerminalsBySession((current) => { const next = { ...current }; delete next[archivedTerminalSessionId]; return next; });
        if (archivedTerminalSessionId === terminalSessionId) setTerminalOpen(false);
        await refresh();
      } catch (reason) { if (isActiveSession) updateConnected(true); setNotice({ title: "Could not archive conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
      return;
    }
    const selectedTransport = selectSession(session); if (!selectedTransport) return;
    if (action === "rename") { setRenameSession(session); return; }
    if (action === "clone") { try { await selectedTransport.connect(); await selectedTransport.command({ type: "clone" }); await syncSessionIndex(); } catch (reason) { setNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); } }
  };
  const startTerminal = async (terminalId: string, cols: number, rows: number) => {
    if (!connectionReadyRef.current) return;
    const sessionKey = activeConversationKeyRef.current;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = activeCwd ?? sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId)?.cwd;
    if (!cwd) { queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n"); return; }
    try { await transport.startTerminal(terminalId, cwd, cols, rows); } catch (reason) { queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); }
  };
  const addTerminal = () => { if (!connectionReadyRef.current) return; const sessionKey = activeConversationKeyRef.current; setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); if (session.tabs.length >= MAX_TERMINALS) return current; const id = `terminal-${sessionKey}-${crypto.randomUUID()}`; return { ...current, [sessionKey]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; }); };
  const selectTerminal = (terminalId: string) => { if (!connectionReadyRef.current) return; const sessionKey = activeConversationKeyRef.current; setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, activeId: terminalId } }; }); };
  const saveTerminalSnapshot = (sessionKey: string, terminalId: string, snapshot: string, snapshotEnd: number) => { setTerminalsBySession((current) => { const session = current[sessionKey]; if (!session?.tabs.some((terminal) => terminal.id === terminalId)) return current; return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, snapshot, snapshotEnd } : terminal) } }; }); };
  const deleteTerminal = async () => {
    if (!connectionReadyRef.current) return;
    const terminalId = activeTerminal.id; const closingLast = sessionTerminals.tabs.length === 1;
    try { await transport.closeTerminal(terminalId); } catch (reason) { setNotice({ title: "Could not close terminal", message: reason instanceof Error ? reason.message : String(reason) }); return; }
    if (closingLast) setTerminalOpen(false);
    const sessionKey = activeConversationKeyRef.current;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current }; if (!tabs.length) delete next[sessionKey]; else next[sessionKey] = { activeId: tabs[0].id, tabs }; return next; });
  };
  const setComposerDraft = (value: string) => { const sessionKey = activeConversationKeyRef.current; setComposerDrafts((current) => { if (value) return { ...current, [sessionKey]: value }; const next = { ...current }; delete next[sessionKey]; return next; }); };
  const setSplitComposerDraft = (value: string) => setComposerDrafts((current) => { if (value) return { ...current, [splitSessionId]: value }; const next = { ...current }; delete next[splitSessionId]; return next; });
  const toggleTerminal = () => { if (!canLeaveSettings()) return; setView("chat"); setTerminalOpen((open) => !open); };
  const toggleDebugMode = useCallback(() => {
    const next = { ...settings, debugMode: !settings.debugMode };
    void transport.saveSettings(next, false).then(() => setSettings(next)).catch((reason) => setNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) }));
  }, [settings, transport]);

  useEffect(() => {
    const handleKeybind = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector('[aria-modal="true"]')) return;
      const binding = keybindDefinitions.find((item) => matchesShortcut(event, settings.keybindings[item.action]));
      if (!binding) return;
      event.preventDefault();
      if (binding.action === "newConversation") { void newSession(); return; }
      if (binding.action === "toggleConversations") { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen((open) => !open); return; }
      if (binding.action === "toggleTerminal") { toggleTerminal(); return; }
      if (binding.action === "toggleDebugMode") { toggleDebugMode(); return; }
      if (binding.action === "openSettings") { setView("settings"); return; }
      if (!canLeaveSettings()) return; setView("chat"); window.setTimeout(() => { if (activePane === "split" && splitPane) setSplitComposerFocusRequest((value) => value + 1); else setMainComposerFocusRequest((value) => value + 1); }, 0);
    };
    window.addEventListener("keydown", handleKeybind);
    return () => window.removeEventListener("keydown", handleKeybind);
  }, [settings.keybindings, toggleDebugMode, settingsDirty, view, activePane, splitPane]);

  const extensionStateIsCurrent = extensionOwner === transport;
  const settingsWithMcpStatuses = { ...settings, mcpServers: settings.mcpServers.map((server) => ({ ...server, ...(extensionStateIsCurrent ? mcpStatuses[server.id] : undefined) })) };
  const activeDialog = dialogs.find((dialog) => dialog.transport === transport);
  return <div className="app dark">
    {import.meta.env.MODE === "e2e" && <div className="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /></div>}
    <aside className="icon-rail">{activeBranch && <div className="rail-branch" title={activeBranch}><GitBranch size={13} /><span>{activeBranch}</span></div>}<nav><IconButton label="New conversation" onClick={newSession}><Plus size={19} /></IconButton><IconButton label="Conversations" className={view === "chat" ? "active" : ""} onClick={() => { if (canLeaveSettings()) setView("chat"); }}><MessageSquare size={18} /></IconButton><IconButton label="New project" onClick={() => setProjectOpen(true)}><FolderGit2 size={18} /></IconButton><IconButton label={settings.debugMode ? "Disable debug mode" : "Enable debug mode"} className={settings.debugMode ? "active" : ""} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label="Settings" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={19} /></IconButton></nav>{view === "chat" && panelOpen && <SessionPanel sessions={sessions} activeId={state.sessionId} activeHostId={activeHostId} runningSessions={runningSessions} unseenSessions={unseenSessions} query={query} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} />}<div className="rail-bottom">{codexUsage !== undefined && <span className="codex-usage" aria-label="Codex usage remaining" title="Codex usage remaining">{codexUsage.remainingPercent}% left{codexUsage.resetAt ? ` · ${formatCodexReset(codexUsage.resetAt)}` : ""}</span>}</div></aside>
    {view === "chat" ? <div className="chat-workspace"><div className={`chat-panes ${splitPane ? "split" : ""}`}><ChatView state={state} messages={messages} gitDiffs={gitDiffs} promptContext={extensionStateIsCurrent ? promptContext : undefined} debug={settings.debugMode} agents={extensionStateIsCurrent ? orchestration?.config.agents ?? [] : []} sequences={extensionStateIsCurrent ? orchestration?.config.sequences ?? [] : []} activeAgent={extensionStateIsCurrent ? orchestration?.active : undefined} dictionaries={settings.dictionaries.filter((item) => settings.activeDictionaryIds.includes(item.id))} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={extensionStateIsCurrent ? Object.values(widgets).flat() : []} statuses={extensionStateIsCurrent ? Object.values(statuses) : []} projectCwd={selectedProjectCwd(activeCwd, transport.isTemporaryChat())} controlsDisabled={!connected} draft={composerDraft} onDraftChange={setComposerDraft} focusRequest={mainComposerFocusRequest} onActivate={() => setActivePane("main")} uploads={composerUploads} onUploadsChange={setComposerUploads} onSend={send} onAbort={abortInteraction} onOpenTerminal={() => setTerminalOpen(true)} onOpenProject={chooseChatProject} onBranch={branch} onAgent={setAgent} onModel={setModel} onThinking={setThinking} />{splitPane && <SplitChatPane key={splitSessionId} runtimePool={runtimePool} session={splitPane.session} settings={settings} draft={splitComposerDraft} onDraftChange={setSplitComposerDraft} focusRequest={splitComposerFocusRequest} onActivate={() => setActivePane("split")} forkFrom={splitPane.btw?.forkFrom} initialPrompt={splitPane.btw?.task} onReady={splitPane.btw ? () => respondToBtw(splitPane.btw!.requestId, { value: "opened" }) : undefined} onFailed={splitPane.btw ? () => respondToBtw(splitPane.btw!.requestId, { cancelled: true }) : undefined} onClose={closeSplitPane} />}</div>{terminalOpen && <TerminalView key={`${terminalSessionId}:${activeTerminal.id}`} cwd={activeCwd ?? sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId)?.cwd} terminals={sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={activeTerminal.id} output={activeTerminal.output} outputEnd={activeTerminal.outputEnd} snapshot={activeTerminal.snapshot} snapshotEnd={activeTerminal.snapshotEnd} started={activeTerminal.started} exited={activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={(data) => { if (!connectionReadyRef.current) return; void transport.writeTerminal(activeTerminal.id, data).catch((reason) => queueTerminalOutput(activeTerminal.id, `\r\nTerminal input failed: ${String(reason)}\r\n`)); }} onResize={(cols, rows) => { if (!connectionReadyRef.current) return; void transport.resizeTerminal(activeTerminal.id, cols, rows).catch(() => undefined); }} onSnapshot={(value, outputEnd) => saveTerminalSnapshot(terminalSessionId, activeTerminal.id, value, outputEnd)} onDelete={deleteTerminal} onClose={() => setTerminalOpen(false)} />}</div> : <SettingsView settings={settingsWithMcpStatuses} orchestration={extensionStateIsCurrent ? orchestration?.config : undefined} models={models} thinkingLevels={thinkingLevels} onSave={saveSettings} onDirtyChange={setSettingsDirty} />}
    {(error || notice) && <div className="toast-stack">
      {error && <div className="error-toast"><strong>Pi could not connect</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
      {notice && <div className="error-toast"><strong>{notice.title}</strong><span>{notice.message}</span><button onClick={() => setNotice(undefined)}>×</button></div>}
    </div>}
    {activeDialog && !projectOpen && !renameSession && !relocatingSession && <ExtensionDialog request={activeDialog.request} onRespond={async (response) => { await activeDialog.transport.command({ type: "extension_ui_response", id: activeDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== activeDialog)); }} />}
    {projectOpen && <ProjectDialog initialPath="" hosts={settings.hosts} initialHostId={activeHostId} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => hostId === "local" ? transport.selectProjectDirectory(currentPath || undefined) : transport.listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />}
    {renameSession && <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: renameSession.name }} onRespond={async (response) => { if (response.cancelled) { setRenameSession(undefined); return; } if (typeof response.value !== "string" || !response.value.trim()) throw new Error("Conversation name can't be empty"); const name = response.value.trim(); await transport.command({ type: "set_session_name", name }); setState((current) => ({ ...current, sessionName: name })); await refresh(); setRenameSession(undefined); }} />}
    {relocatingSession && <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${relocatingSession.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${relocatingSession.cwd}. Enter its new location to open this conversation.`, error: relocationError, placeholder: "Replacement project directory", prefill: sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId && session.cwdExists !== false)?.cwd || "" }} onRespond={(response) => { if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; } const cwd = typeof response.value === "string" ? response.value.trim() : ""; if (!cwd) { setRelocationError("Path can't be empty"); return; } const session = relocatingSession; setRelocationError(undefined); setRelocatingSession(undefined); void transport.relocateSession(session.path, cwd, session.hostId).then(() => { selectSession({ ...session, cwd, cwdExists: true }); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }} />}
  </div>;
}
