import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { ArrowLeft, Bug, FolderPlus, GitBranch, MessageSquare, Settings } from "lucide-react";
import { ChatView } from "./components/ChatView";
import { IconButton } from "./components/IconButton";
import { SessionPanel, type SessionAction } from "./components/SessionPanel";
import { SettingsView } from "./components/SettingsView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { TerminalView } from "./components/TerminalView";
import { ProjectDialog } from "./components/ProjectDialog";
import { WorktreeDialog } from "./components/WorktreeDialog";
import { SplitChatPane } from "./components/SplitChatPane";
import { keybindDefinitions, matchesShortcut } from "./lib/keybindings";
import { findReplaceableAbortedTurn } from "./lib/abortedTurn";
import { NativeTransport } from "./lib/nativeTransport";
import { SessionRuntimePool, useTurnDiffs } from "./lib/sessionRuntimePool";
import { useChatSession } from "./lib/useChatSession";
import { decodeOrchestrationValue, encodeOrchestrationValue, ORCHESTRATION_STATUS_KEY } from "./lib/orchestrationProtocol";
import { appendTerminalOutput as retainTerminalOutput, TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import type { AgentState, AppSettings, ChatMessage, CodexUsage, ComposerUpload, ExtensionUiRequest, ImageAttachment, Model, OrchestrationCapability, OrchestrationConfig, RpcEvent, SessionSummary } from "./types";
import { branchMessages, type PiEntry } from "./lib/messages";

const staleExtensionContext = "This extension ctx is stale after session replacement or reload.";
type TerminalTabState = { id: string; output: string; outputEnd: number; snapshot?: string; snapshotEnd?: number; started: boolean; exited?: boolean };
type SessionTerminals = { activeId: string; tabs: TerminalTabState[] };
type QueuedTerminalOutput = { data: string; length: number };
type BtwRequest = { task: string; forkFrom: string; requestId: string };
type SplitPaneState = { session: SessionSummary; btw?: BtwRequest };
type OwnedExtensionDialog = { request: ExtensionUiRequest; transport: NativeTransport; owner: string; queueId: string };
type RenameTarget = { session: SessionSummary; transport: NativeTransport };
type WorktreeTarget = { cwd: string; hostId: string; message: ChatMessage };
type TerminalTarget = { sessionKey: string; cwd?: string; hostId: string };
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]); const [settings, setSettings] = useState<AppSettings>(); const [orchestration, setOrchestration] = useState<OrchestrationCapability>();
  const [debugModeSaving, setDebugModeSaving] = useState(false);
  const debugModePending = useRef(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const sessionIndexRequest = useRef<Promise<void> | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(true); const [query, setQuery] = useState(""); const [connected, setConnected] = useState(false); const connectionReadyRef = useRef(connected); connectionReadyRef.current = connected; const updateConnected = (value: boolean) => { connectionReadyRef.current = value; setConnected(value); }; const [error, setError] = useState<string>();
  const [createGroupRequest, setCreateGroupRequest] = useState(0);
  const [activeHostId, setActiveHostId] = useState("local");
  const [activeCwd, setActiveCwd] = useState<string>();
  const [activeBranch, setActiveBranch] = useState<string>();
  const [isGitRepository, setIsGitRepository] = useState(false);
  const activeHostIdRef = useRef(activeHostId); activeHostIdRef.current = activeHostId;
  const [codexUsage, setCodexUsage] = useState<CodexUsage>();
  const [, setUsageClock] = useState(0);
  const [dialogs, setDialogs] = useState<OwnedExtensionDialog[]>([]); const [notices, setNotices] = useState<Array<{ id: string; title: string; message: string }>>([]);
  const dialogsRef = useRef(dialogs); dialogsRef.current = dialogs;
  const mainDialogOwnerRef = useRef("Main conversation"); mainDialogOwnerRef.current = state.sessionName ? `Main: ${state.sessionName}` : "Main conversation";
  const addNotice = useCallback((notice: { title: string; message: string }) => setNotices((current) => [...current, { ...notice, id: crypto.randomUUID() }]), []);
  const queueExtensionDialog = useCallback((request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => setDialogs((current) => [...current, { request, transport: ownerTransport, owner, queueId: crypto.randomUUID() }]), []);
  const closeTransportDialogs = useCallback(async (ownerTransport: NativeTransport) => {
    const closing = dialogsRef.current.filter((dialog) => dialog.transport === ownerTransport);
    setDialogs((current) => current.filter((dialog) => dialog.transport !== ownerTransport));
    await Promise.allSettled(closing.map((dialog) => ownerTransport.command({ type: "extension_ui_response", id: dialog.request.id, cancelled: true })));
  }, []);
  const releaseSplitTransport = useCallback(async (ownerTransport: NativeTransport) => {
    // Selecting a split conversation transfers its runtime to the main pane.
    if (activeTransportRef.current === ownerTransport) return;
    await closeTransportDialogs(ownerTransport);
    if (activeTransportRef.current !== ownerTransport) await runtimePool.release(ownerTransport);
  }, [closeTransportDialogs, runtimePool]);
  const [statuses, setStatuses] = useState<Record<string, string>>({}); const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [extensionOwner, setExtensionOwner] = useState(transport);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, { status: "connected" | "stopped" | "error"; error?: string }>>({});
  const [renameSession, setRenameSession] = useState<RenameTarget>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [worktreeTarget, setWorktreeTarget] = useState<WorktreeTarget>();
  const projectOpenRef = useRef(projectOpen); projectOpenRef.current = projectOpen;
  const projectOpenRequest = useRef(0);
  const [relocatingSession, setRelocatingSession] = useState<SessionSummary>(); const [relocationError, setRelocationError] = useState<string>();
  const relocationActionRef = useRef<"select" | "split" | "rename">("select");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>();
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [uploadsByTransport, setUploadsByTransport] = useState<Map<NativeTransport, ComposerUpload[]>>(() => new Map());
  const newSessionPending = useRef(false);
  const abortPending = useRef(new Set<NativeTransport>());
  const pauseResumePending = useRef(new Set<NativeTransport>());
  const branchPending = useRef(new Set<string>());
  const archivePending = useRef(new Set<string>());
  const sessionActionPending = useRef(new Set<string>());
  const [splitPane, setSplitPane] = useState<SplitPaneState>();
  const [mainComposerFocusRequest, setMainComposerFocusRequest] = useState(0);
  const [splitComposerFocusRequest, setSplitComposerFocusRequest] = useState(0);
  const [activePane, setActivePane] = useState<"main" | "split">("main");
  const pendingBtwRequest = useRef<{ id: string; transport: NativeTransport } | undefined>(undefined);
  const [terminalsBySession, setTerminalsBySession] = useState<Record<string, SessionTerminals>>({});
  const closingTerminals = useRef(new Set<string>());
  const startingTerminals = useRef(new Set<string>());
  const terminalPanelRevision = useRef(0);
  const controlQueues = useRef(new WeakMap<NativeTransport, Promise<void>>());
  const reconnectPending = useRef(new Set<NativeTransport>());
  const queuedTerminalOutput = useRef(new Map<string, QueuedTerminalOutput>()); const terminalOutputFrame = useRef<number | undefined>(undefined);
  const splitSessionId = splitPane ? `${splitPane.session.hostId ?? "local"}:${splitPane.session.id}` : "";
  const terminalSessionId = terminalTarget?.sessionKey ?? activeConversationKey;
  const terminalSessionIdRef = useRef(terminalSessionId); terminalSessionIdRef.current = terminalSessionId;
  const terminalCwd = terminalTarget?.cwd ?? activeCwd ?? sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId)?.cwd;
  const terminalHostId = terminalTarget?.hostId ?? activeHostId;
  const composerDraft = composerDrafts[activeConversationKey] ?? "";
  const composerUploads = uploadsByTransport.get(transport) ?? [];
  const splitComposerDraft = composerDrafts[splitSessionId] ?? "";
  const sessionTerminals = terminalsBySession[terminalSessionId] ?? initialTerminals(terminalSessionId);
  const activeTerminal = sessionTerminals.tabs.find((terminal) => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];
  const terminalsBySessionRef = useRef(terminalsBySession); terminalsBySessionRef.current = terminalsBySession;
  const activateConversationKey = (key: string) => { activeConversationKeyRef.current = key; setActiveConversationKey(key); };
  useEffect(() => { runtimePool.setErrorHandler((message) => addNotice({ title: "Project changes", message })); runtimePool.setBackgroundInputHandler((request) => addNotice({ title: "Background conversation requested input", message: `${request.title || "Input requested"} was cancelled. Open that conversation and try again.` })); return () => { runtimePool.setErrorHandler(); runtimePool.setBackgroundInputHandler(); }; }, [addNotice, runtimePool]);

  const flushTerminalOutput = useCallback(() => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();
    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  }, []);
  const queueTerminalOutput = useCallback((terminalId: string, data: string) => {
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });
    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = window.setTimeout(flushTerminalOutput, 0);
  }, [flushTerminalOutput]);

  useEffect(() => { let cancelled = false; const load = () => void transport.loadCodexUsage().then((usage) => { if (!cancelled) setCodexUsage(usage); }).catch(() => undefined); load(); const interval = window.setInterval(load, 60_000); window.addEventListener("focus", load); return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener("focus", load); }; }, [transport]);
  useEffect(() => { newSessionPending.current = false; }, [transport]);
  useEffect(() => {
    const previousKey = activeConversationKeyRef.current;
    if (!state.sessionId || !previousKey.includes(":draft-")) return;
    const canonicalKey = `${activeHostId}:${state.sessionId}`;
    if (previousKey === canonicalKey) return;
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    transportConversationKeys.current.set(transport, canonicalKey); activateConversationKey(canonicalKey);
  }, [activeHostId, state.sessionId, transport]);
  useEffect(() => {
    document.title = "Pi";
    setStatuses({}); setWidgets({});
  }, [transport]);
  useEffect(() => {
    let cancelled = false;
    setActiveBranch(undefined); setIsGitRepository(false);
    void transport.gitBranch().then((branch) => { if (!cancelled) setActiveBranch(branch ?? undefined); }).catch(() => undefined);
    void transport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);
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
    void syncSessionIndex();
    const settingsRequest = transport.loadSettings().then((nextSettings) => { setSettings(nextSettings); return nextSettings; });
    const [nextState, nextSettings] = await Promise.all([refreshSession(), settingsRequest]); runtimePool.bind(hostId ?? transport.currentHostId(), nextState.sessionId, transport); return nextSettings;
  }, [refreshSession, runtimePool, syncSessionIndex, transport]);

  const configureRuntime = useCallback(async (value: AppSettings) => {
    const [modelResult, thinkingResult] = await Promise.allSettled([
      transport.command<{ models: Model[] }>({ type: "get_available_models" }),
      transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
    ]);
    await Promise.all([
      transport.command({ type: "set_auto_compaction", enabled: value.autoCompaction }),
      transport.command({ type: "set_auto_retry", enabled: value.autoRetry }),
    ]);
    const availableModels = modelResult.status === "fulfilled" ? modelResult.value.models : [];
    const availableThinkingLevels = thinkingResult.status === "fulfilled" ? thinkingResult.value.levels : [];
    const defaultModel = availableModels.find((model) => `${model.provider}/${model.id}` === value.defaultModel);
    if (!defaultModel && availableModels.length) throw new Error(`Default model is unavailable: ${value.defaultModel}`);
    if (availableThinkingLevels.length && !availableThinkingLevels.includes(value.defaultThinking)) throw new Error(`Default thinking level is unavailable: ${value.defaultThinking}`);
    if (!transport.currentSessionPath() && defaultModel) {
      await transport.command({ type: "set_model", provider: defaultModel.provider, modelId: defaultModel.id });
      if (availableThinkingLevels.includes(value.defaultThinking)) await transport.command({ type: "set_thinking_level", level: value.defaultThinking });
    }
  }, [transport]);
  const resolveHomeDirectory = useCallback((hostId: string) => transport.homeDirectory(hostId), [transport]);

  useEffect(() => {
    let cancelled = false; let reconnecting = false;
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      if (event.type === "terminal_output") queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
      if (event.type === "terminal_exit") setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal) }])));
      if (event.type === "extension_error") { const message = String(event.error ?? "An extension failed"); if (!message.startsWith(staleExtensionContext)) addNotice({ title: "Extension error", message }); }
      if (event.type === "extension_ui_request") { const request = event as unknown as ExtensionUiRequest;
        if (transport !== activeTransportRef.current) { if (["input", "editor", "select", "confirm"].includes(request.method)) void transport.command({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => undefined); return; }
        if (request.method === "notify") addNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "Pi extension", message: request.message || "Notification" });
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
            addNotice({ title: "Could not start /btw", message: reason instanceof Error ? reason.message : String(reason) });
          }
        }
        else if (request.method === "setStatus" && request.statusKey === ORCHESTRATION_STATUS_KEY) { setExtensionOwner(transport); try {
          const capability = request.statusText?.startsWith("json:") ? decodeOrchestrationValue<OrchestrationCapability>(request.statusText.slice(5)) : undefined;
          setOrchestration(capability);
          if (capability) void refreshSession().catch(() => undefined);
        } catch { setOrchestration(undefined); } }
        else if (request.method === "setStatus" && request.statusKey === MCP_STATUS_KEY) { setExtensionOwner(transport); try { const values = request.statusText?.startsWith("json:") ? JSON.parse(request.statusText.slice(5)) as Array<{ id: string; status: "connected" | "stopped" | "error"; error?: string }> : []; setMcpStatuses(Object.fromEntries(values.map((value) => [value.id, { status: value.status, error: value.error }]))); } catch { setMcpStatuses({}); } }
        else if (request.method === "setStatus" && request.statusKey && request.statusKey !== PROMPT_CONTEXT_STATUS_KEY) { setExtensionOwner(transport); setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; }); }
        else if (request.method === "setWidget" && request.widgetKey) { setExtensionOwner(transport); setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = request.widgetLines; else delete next[request.widgetKey!]; return next; }); }
        else if (request.method === "setTitle") document.title = request.title || "Pi";
        else if (request.method === "set_editor_text") { setComposerDrafts((current) => { const key = transportConversationKeys.current.get(transport) ?? terminalSessionIdRef.current; const next = { ...current }; if (request.text) next[key] = request.text; else delete next[key]; return next; }); setActivePane("main"); setMainComposerFocusRequest((value) => value + 1); }
        else queueExtensionDialog(request, transport, mainDialogOwnerRef.current);
      }
      if (event.type === "session_switched") void refresh();
      if (event.type === "session_info_changed") void refresh();
      if (event.type === "disconnected") {
        setOrchestration(undefined); setMcpStatuses({}); setStatuses({}); setWidgets({}); document.title = "Pi"; setDialogs((current) => current.filter((dialog) => dialog.transport !== transport)); updateConnected(false);
        if (reconnecting) return; reconnecting = true;
        window.setTimeout(() => {
          if (cancelled) return; const diagnostic = transport.lastDiagnostic();
          void transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { if (!cancelled) { setError(undefined); updateConnected(true); } }).catch((reason: unknown) => { if (!cancelled) { const message = reason instanceof Error ? reason.message : String(reason); setError(diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message); } }).finally(() => { reconnecting = false; });
        }, 50);
      }
    });
    transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { if (!cancelled) { setError(undefined); updateConnected(true); } }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; unsubscribe(); if (terminalOutputFrame.current !== undefined) window.clearTimeout(terminalOutputFrame.current); terminalOutputFrame.current = undefined; queuedTerminalOutput.current.clear(); };
  }, [addNotice, configureRuntime, handleEvent, queueExtensionDialog, queueTerminalOutput, refresh, refreshSession, transport]);

  useEffect(() => { const shutdown = () => { for (const session of Object.values(terminalsBySessionRef.current)) for (const terminal of session.tabs) void transport.closeTerminal(terminal.id).catch(() => undefined); void runtimePool.disconnectAll(); }; window.addEventListener("pagehide", shutdown); return () => window.removeEventListener("pagehide", shutdown); }, [runtimePool, transport]);
  useEffect(() => { if (!settingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [settingsDirty]);
  useEffect(() => { runtimePool.activate(view === "chat" ? transport : undefined); }, [runtimePool, transport, view]);

  useEffect(() => {
    if (!connected || !settings) return;
    const interval = window.setInterval(() => void syncSessionIndex(), settings.hosts.length ? 5000 : 1500);
    return () => window.clearInterval(interval);
  }, [connected, settings, syncSessionIndex]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (!connectionReadyRef.current) throw new Error("Pi is still connecting");
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
    if (behavior) { await ownerTransport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setState((current) => ({ ...current, pendingMessageCount: current.pendingMessageCount + 1 })); return; }
    const abandoned = !state.isPaused && !state.isPausing ? findReplaceableAbortedTurn(messages) : undefined;
    if (abandoned) {
      let oldSessionPath = state.sessionFile;
      if (!oldSessionPath) oldSessionPath = (await transport.command<AgentState>({ type: "get_state" })).sessionFile;
      if (!oldSessionPath) throw new Error("Cannot replace an aborted turn before the session has been saved");
      let entryId = abandoned.user.entryId;
      if (!entryId) { const response = await transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); entryId = findReplaceableAbortedTurn(branchMessages(response.entries, response.leafId))?.user.entryId; }
      if (!entryId) throw new Error("Cannot find the abandoned turn in the saved session");
      const fork = await transport.command<{ cancelled?: boolean }>({ type: "fork", entryId });
      if (fork.cancelled) return false;
      const previousKey = activeConversationKeyRef.current;
      const nextState = await refreshSession();
      runtimePool.bind(activeHostIdRef.current, nextState.sessionId, transport);
      rekeyConversationUi(previousKey, `${activeHostIdRef.current}:${nextState.sessionId}`, transport);
      const history = await transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" });
      await runtimePool.copySavedDiffs(transport, oldSessionPath, transport.currentSessionPath(), new Set(branchMessages(history.entries, history.leafId).map((entry) => entry.id)));
      await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
      try {
        await transport.deleteSession(oldSessionPath, activeHostId);
        setSessions((current) => current.filter((session) => session.path !== oldSessionPath || (session.hostId ?? "local") !== activeHostId));
      } catch (reason) { addNotice({ title: "Replacement sent, but the old conversation could not be removed", message: reason instanceof Error ? reason.message : String(reason) }); }
      return true;
    }
    await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
    return true;
  };
  const respondToBtw = (requestId: string, response: { value?: string; cancelled?: boolean }) => {
    const pending = pendingBtwRequest.current; if (!pending || pending.id !== requestId) return;
    pendingBtwRequest.current = undefined;
    void pending.transport.command({ type: "extension_ui_response", id: requestId, ...response }).catch((reason) => addNotice({ title: "Could not finish /btw request", message: reason instanceof Error ? reason.message : String(reason) }));
  };
  const closeSplitPane = () => { if (splitPane?.btw) respondToBtw(splitPane.btw.requestId, { cancelled: true }); setSplitPane(undefined); setActivePane("main"); };
  const canLeaveSettings = () => view !== "settings" || !settingsDirty || window.confirm("Discard unsaved settings changes?");
  const setComposerUploads = (ownerTransport: NativeTransport, update: SetStateAction<ComposerUpload[]>) => setUploadsByTransport((current) => {
    const next = new Map(current);
    const uploads = typeof update === "function" ? update(next.get(ownerTransport) ?? []) : update;
    if (uploads.length) next.set(ownerTransport, uploads); else next.delete(ownerTransport);
    return next;
  });
  const activateTransport = (nextTransport: NativeTransport) => {
    const previousTransport = transport;
    const previousKey = transportConversationKeys.current.get(previousTransport);
    const hasUnsavedWork = Boolean((previousKey && composerDrafts[previousKey]?.trim()) || (uploadsByTransport.get(previousTransport)?.length));
    const discardPrevious = previousTransport !== nextTransport && !state.isStreaming && state.messageCount === 0 && messages.length === 0 && !hasUnsavedWork;
    activeTransportRef.current = nextTransport; runtimePool.activate(nextTransport); setTransport(nextTransport);
    if (discardPrevious) {
      setUploadsByTransport((current) => { const next = new Map(current); next.delete(previousTransport); return next; });
      if (previousKey) {
        setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
        const terminalIds = terminalsBySession[previousKey]?.tabs.map((terminal) => terminal.id) ?? [];
        if (terminalIds.length) void Promise.allSettled(terminalIds.map((id) => previousTransport.closeTerminal(id)));
        setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
      }
      void runtimePool.release(previousTransport).finally(() => transportConversationKeys.current.delete(previousTransport));
    }
  };
  const rekeyConversationUi = (previousKey: string, nextKey: string, ownerTransport: NativeTransport, moveTerminals = true) => {
    if (previousKey === nextKey) return;
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; delete next[previousKey]; return next; });
    if (moveTerminals) setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; delete next[previousKey]; return next; });
    transportConversationKeys.current.set(ownerTransport, nextKey);
    if (ownerTransport === activeTransportRef.current) activateConversationKey(nextKey);
  };
  const branchConversation = async (message: ChatMessage, destinationCwd?: string) => {
    const entryId = message.entryId; if (!entryId) throw new Error("Could not find the response to branch from");
    const ownerTransport = transport; const previousKey = activeConversationKeyRef.current;
    const pendingKey = `${previousKey}:${entryId}`;
    if (branchPending.current.has(pendingKey)) return false;
    const sourcePath = ownerTransport.currentSessionPath() ?? state.sessionFile;
    if (!sourcePath) throw new Error("The original conversation has no session file");
    branchPending.current.add(pendingKey);
    const sourceCwd = ownerTransport.currentCwd();
    const sourceHostId = ownerTransport.currentHostId();
    let forked = false;
    try {
      const messageIndex = messages.findIndex((candidate) => candidate.entryId === entryId);
      const nextUserEntryId = messageIndex >= 0 ? messages.slice(messageIndex + 1).find((candidate) => candidate.role === "user" && candidate.entryId)?.entryId : undefined;
      const fork = await ownerTransport.command<{ cancelled?: boolean }>(nextUserEntryId ? { type: "fork", entryId: nextUserEntryId } : { type: "clone" }); if (fork.cancelled) return false;
      forked = true;
      let nextState = await ownerTransport.command<AgentState>({ type: "get_state" });
      let history = await ownerTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" });
      try { await runtimePool.copySavedDiffs(ownerTransport, sourcePath, nextState.sessionFile, new Set(branchMessages(history.entries, history.leafId).map((entry) => entry.id))); }
      catch (reason) { addNotice({ title: "Conversation branched, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); }
      if (destinationCwd) {
        if (!nextState.sessionFile) throw new Error("The branched conversation has no session file");
        await ownerTransport.relocateSession(nextState.sessionFile, destinationCwd, sourceHostId);
        if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === previousKey) updateConnected(false);
        await ownerTransport.disconnect(); await ownerTransport.connect(destinationCwd, nextState.sessionFile, sourceHostId);
        const nextSettings = await ownerTransport.loadSettings(); await configureRuntime(nextSettings); nextState = await ownerTransport.command<AgentState>({ type: "get_state" }); history = await ownerTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" });
      }
      const nextKey = `${sourceHostId}:${nextState.sessionId}`;
      runtimePool.bind(sourceHostId, nextState.sessionId, ownerTransport);
      rekeyConversationUi(previousKey, nextKey, ownerTransport, !destinationCwd);
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === nextKey) {
        if (destinationCwd) { setActiveCwd(destinationCwd); setTerminalOpen(false); setTerminalTarget(undefined); }
        setState(nextState); setMessages(branchMessages(history.entries, history.leafId)); updateConnected(true);
      }
      void syncSessionIndex(); return true;
    } catch (reason) {
      if (!forked || !sourcePath) throw reason;
      try {
        if (activeTransportRef.current === ownerTransport) updateConnected(false);
        await ownerTransport.disconnect();
        await ownerTransport.connect(sourceCwd, sourcePath, sourceHostId);
        if (activeTransportRef.current === ownerTransport) setActiveCwd(sourceCwd);
        const restoredSettings = await ownerTransport.loadSettings();
        await configureRuntime(restoredSettings);
        const restoredState = await ownerTransport.command<AgentState>({ type: "get_state" });
        const restoredHistory = await ownerTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" });
        transportConversationKeys.current.set(ownerTransport, previousKey);
        if (activeTransportRef.current === ownerTransport) { activateConversationKey(previousKey); setState(restoredState); setMessages(branchMessages(restoredHistory.entries, restoredHistory.leafId)); updateConnected(true); }
      } catch (rollbackReason) {
        const originalMessage = reason instanceof Error ? reason.message : String(reason);
        const rollbackMessage = rollbackReason instanceof Error ? rollbackReason.message : String(rollbackReason);
        throw new Error(`${originalMessage}\nCould not restore the original conversation: ${rollbackMessage}`);
      }
      throw reason;
    } finally { branchPending.current.delete(pendingKey); }
  };
  const branch = async (message: ChatMessage) => { try { await branchConversation(message); } catch (reason) { addNotice({ title: "Could not branch conversation", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const newSession = async () => { if (newSessionPending.current || !canLeaveSettings()) return; if ((composerDraft.trim() || composerUploads.length) && !window.confirm("Start a new conversation and discard the unsent draft?")) return; newSessionPending.current = true; const hostId = activeHostIdRef.current; const projectCwd = selectedProjectCwd(activeCwd, transport.isTemporaryChat()); const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; activateConversationKey(conversationKey); setView("chat"); closeSplitPane(); setTerminalOpen(false); setTerminalTarget(undefined); updateConnected(false); setOrchestration(undefined); discardPendingUpdates(); setMessages([]); setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isPaused: false, isPausing: false, activity: undefined, contextUsage: undefined })); const nextTransport = runtimePool.create(projectCwd ? { cwd: projectCwd, hostId } : { hostId }); transportConversationKeys.current.set(nextTransport, conversationKey); try { const cwd = projectCwd ?? await nextTransport.prepareTemporaryChat(hostId); if (activeConversationKeyRef.current !== conversationKey) { transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport); return; } setActiveCwd(cwd); setActiveHostId(hostId); activateTransport(nextTransport); } catch (reason) { transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport); if (activeConversationKeyRef.current === conversationKey) { updateConnected(false); setError(reason instanceof Error ? reason.message : String(reason)); } } finally { newSessionPending.current = false; } };
  const selectSession = (session: SessionSummary) => {
    const selectedKey = `${session.hostId ?? "local"}:${session.id}`; if (archivePending.current.has(selectedKey)) return undefined;
    const hostId = session.hostId ?? "local"; if (session.id === state.sessionId && hostId === activeHostId) { if (!connected) void transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { setError(undefined); updateConnected(true); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); return transport; }
    if (splitPane?.session.id === session.id && (splitPane.session.hostId ?? "local") === hostId) closeSplitPane();
    if (session.cwdExists === false) { relocationActionRef.current = "select"; setRelocationError(undefined); setRelocatingSession(session); return undefined; }
    const nextTransport = runtimePool.forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setOrchestration(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); setMessages([]); setState((value) => ({ ...value, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, isStreaming: false, isPaused: false, isPausing: false, activity: undefined })); activateTransport(nextTransport); return nextTransport;
  };
  const enqueueControl = (ownerTransport: NativeTransport, action: () => Promise<void>) => { const previous = controlQueues.current.get(ownerTransport) ?? Promise.resolve(); const next = previous.then(action, action); controlQueues.current.set(ownerTransport, next.catch(() => undefined)); return next; };
  const setModel = async (model: Model) => { const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current; try { await enqueueControl(ownerTransport, async () => { await ownerTransport.command({ type: "set_model", provider: model.provider, modelId: model.id }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setState((current) => ({ ...current, model })); }); } catch (reason) { addNotice({ title: "Could not change model", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const setThinking = async (level: string) => { const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current; try { await enqueueControl(ownerTransport, async () => { await ownerTransport.command({ type: "set_thinking_level", level }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setState((current) => ({ ...current, thinkingLevel: level })); }); } catch (reason) { addNotice({ title: "Could not change thinking level", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const abortInteraction = async () => { const ownerTransport = transport; if (abortPending.current.has(ownerTransport)) return; abortPending.current.add(ownerTransport); try { await ownerTransport.command({ type: "abort" }); } catch (reason) { addNotice({ title: "Could not stop Pi", message: reason instanceof Error ? reason.message : String(reason) }); } finally { abortPending.current.delete(ownerTransport); } };
  const pauseInteraction = async () => {
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
    if (abortPending.current.has(ownerTransport) || pauseResumePending.current.has(ownerTransport)) return;
    pauseResumePending.current.add(ownerTransport);
    setState((current) => ({ ...current, isPausing: true }));
    try {
      await ownerTransport.command({ type: "pause" });
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await refreshSession();
    } catch (reason) {
      addNotice({ title: "Could not pause Pi", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      pauseResumePending.current.delete(ownerTransport);
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setState((current) => ({ ...current, isPausing: false }));
    }
  };
  const resumeInteraction = async () => {
    const ownerTransport = transport;
    if (abortPending.current.has(ownerTransport) || pauseResumePending.current.has(ownerTransport)) return;
    pauseResumePending.current.add(ownerTransport);
    try { await ownerTransport.command({ type: "resume" }); }
    catch (reason) { addNotice({ title: "Could not resume Pi", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { pauseResumePending.current.delete(ownerTransport); }
  };
  const saveSettings = async (value: AppSettings, nextConfig?: OrchestrationConfig) => {
    if (!settings) throw new Error("Settings are still loading");
    if (runtimePool.isAnyRunning() || state.isStreaming) throw new Error("Wait for every response to finish before saving settings");
    const clean = (source: AppSettings) => ({ ...source, mcpServers: source.mcpServers.map(({ error: _error, ...server }) => ({ ...server, status: "stopped" as const })) });
    const previous = clean(settings); const previousConfig = orchestration?.config; const next = { ...clean(value), debugMode: settings.debugMode }; const removedActiveHost = activeHostId !== "local" && !next.hosts.some((host) => host.id === activeHostId); let settingsApplied = false; let orchestrationAttempted = false;
    try {
      await transport.saveSettings(next); settingsApplied = true; await configureRuntime(next);
      if (nextConfig) { orchestrationAttempted = true; await transport.command({ type: "prompt", message: `/pi-orchestration-config ${encodeOrchestrationValue(nextConfig)}` }); }
    } catch (reason) {
      if (orchestrationAttempted && previousConfig) await transport.command({ type: "prompt", message: `/pi-orchestration-config ${encodeOrchestrationValue(previousConfig)}` }).catch(() => undefined);
      if (settingsApplied) try { await transport.saveSettings(previous); await configureRuntime(previous); } catch { /* Keep the original failure; NativeTransport owns persistence and reconnect rollback. */ }
      throw reason;
    }
    setSettings(next); await runtimePool.reconnectForSettingsChange(transport, next); if (removedActiveHost) { const conversationKey = `local:draft-${crypto.randomUUID()}`; setActiveHostId("local"); setActiveCwd(transport.currentCwd()); transportConversationKeys.current.set(transport, conversationKey); activateConversationKey(conversationKey); setTerminalOpen(false); setTerminalTarget(undefined); } void refresh().catch((reason) => addNotice({ title: "Settings saved, but the view could not refresh", message: reason instanceof Error ? reason.message : String(reason) }));
  };
  const setAgent = async (name: string) => { try { await transport.command({ type: "prompt", message: `/pi-orchestration-use ${encodeOrchestrationValue(name)}` }); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const openProject = async (cwd: string, hostId: string) => { if (!canLeaveSettings()) return; const request = projectOpenRequest.current; const validatedCwd = await transport.validateProjectDirectory(cwd.trim(), hostId); if (!projectOpenRef.current || request !== projectOpenRequest.current) return; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setOrchestration(undefined); discardPendingUpdates(); setMessages([]); activateConversationKey(conversationKey); setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isPaused: false, isPausing: false, activity: undefined, contextUsage: undefined })); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = runtimePool.create({ cwd: validatedCwd, hostId }); transportConversationKeys.current.set(nextTransport, conversationKey); activateTransport(nextTransport); };
  const chooseChatProject = () => { projectOpenRequest.current += 1; setProjectOpen(true); };
  const openSplitPane = (session: SessionSummary) => { closeSplitPane(); setSplitPane({ session }); };
  const sessionAction = async (session: SessionSummary, action: SessionAction) => {
    if (session.cwdExists === false && (action === "split" || action === "rename")) { relocationActionRef.current = action; setRelocationError(undefined); setRelocatingSession(session); return; }
    if (action === "split") { openSplitPane(session); return; }
    if (action === "open-directory") {
      const actionKey = `open-directory:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
      try { await transport.openProjectDirectory(session.cwd, session.hostId); }
      catch (reason) { addNotice({ title: "Could not open project directory", message: reason instanceof Error ? reason.message : String(reason) }); }
      finally { sessionActionPending.current.delete(actionKey); }
      return;
    }
    if (action === "archive") {
      const archivedSessionKey = `${session.hostId ?? "local"}:${session.id}`;
      if (archivePending.current.has(archivedSessionKey)) return;
      if (!window.confirm(`Archive “${session.name}”?`)) return;
      archivePending.current.add(archivedSessionKey);
      const ownerTransport = runtimePool.forSession(session);
      const isActiveSession = ownerTransport === transport && session.id === state.sessionId && (session.hostId ?? "local") === activeHostId;
      const isSplitSession = splitPane?.session.id === session.id && (splitPane.session.hostId ?? "local") === (session.hostId ?? "local");
      const terminalIds = terminalsBySession[archivedSessionKey]?.tabs.map((terminal) => terminal.id) ?? [];
      try {
        if (runtimePool.isRunning(ownerTransport)) await ownerTransport.command({ type: "abort" });
        if (isSplitSession) closeSplitPane();
        if (!isActiveSession) await runtimePool.remove(session);
        else updateConnected(false);
        await transport.archiveSession(session.path, session.hostId, terminalIds);
        setSessions((current) => current.filter((item) => item.path !== session.path || (item.hostId ?? "local") !== (session.hostId ?? "local")));
        setComposerDrafts((current) => { if (!(archivedSessionKey in current)) return current; const next = { ...current }; delete next[archivedSessionKey]; return next; });
        setTerminalsBySession((current) => { const next = { ...current }; delete next[archivedSessionKey]; return next; });
        if (archivedSessionKey === terminalSessionId) setTerminalOpen(false);
        if (!isActiveSession) { await syncSessionIndex(); return; }
        if (activeTransportRef.current !== ownerTransport || activeConversationKeyRef.current !== archivedSessionKey) { await runtimePool.remove(session); await syncSessionIndex(); return; }
        const hostId = activeHostId; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
        transportConversationKeys.current.set(transport, conversationKey); activateConversationKey(conversationKey); discardPendingUpdates(); setMessages([]);
        setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isPaused: false, isPausing: false, activity: undefined, contextUsage: undefined }));
        if (ownerTransport.isTemporaryChat()) {
          const nextTransport = runtimePool.create({ hostId }); transportConversationKeys.current.set(nextTransport, conversationKey);
          try {
            const cwd = await nextTransport.prepareTemporaryChat(hostId);
            if (activeTransportRef.current !== ownerTransport || activeConversationKeyRef.current !== conversationKey) { transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport); void runtimePool.release(ownerTransport).finally(() => transportConversationKeys.current.delete(ownerTransport)); }
            else { setActiveCwd(cwd); activateTransport(nextTransport); void runtimePool.release(ownerTransport).finally(() => transportConversationKeys.current.delete(ownerTransport)); }
          } catch (reason) {
            transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport);
            addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex();
          }
        } else try { await transport.command({ type: "new_session" }); await refresh(); updateConnected(true); }
        catch (reason) { addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex(); }
      } catch (reason) { if (isActiveSession && activeTransportRef.current === ownerTransport) updateConnected(true); addNotice({ title: "Could not archive conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
      finally { archivePending.current.delete(archivedSessionKey); }
      return;
    }
    if (action === "rename") { setRenameSession({ session, transport: runtimePool.forSession(session) }); return; }
    const actionKey = `${action}:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
    try { const selectedTransport = selectSession(session); if (!selectedTransport) return;
      if (action === "clone") { const sourcePath = session.path; const previousKey = `${session.hostId ?? "local"}:${session.id}`; try { await selectedTransport.connect(); await selectedTransport.command({ type: "clone" }); const nextState = await selectedTransport.command<AgentState>({ type: "get_state" }); runtimePool.bind(session.hostId ?? "local", nextState.sessionId, selectedTransport); rekeyConversationUi(previousKey, `${session.hostId ?? "local"}:${nextState.sessionId}`, selectedTransport); const history = await selectedTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); const nextMessages = branchMessages(history.entries, history.leafId); if (activeTransportRef.current === selectedTransport) { setState(nextState); setMessages(nextMessages); updateConnected(true); } try { await runtimePool.copySavedDiffs(selectedTransport, sourcePath, nextState.sessionFile, new Set(nextMessages.map((entry) => entry.id))); } catch (reason) { addNotice({ title: "Conversation cloned, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); } await syncSessionIndex(); } catch (reason) { addNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); } }
    } finally { sessionActionPending.current.delete(actionKey); }
  };
  const startTerminal = async (terminalId: string, cols: number, rows: number) => {
    if (startingTerminals.current.has(terminalId)) return; startingTerminals.current.add(terminalId);
    const sessionKey = terminalSessionId;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = terminalCwd;
    if (!cwd) { startingTerminals.current.delete(terminalId); setTerminalsBySession((current) => { const session = current[sessionKey]; return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n"); return; }
    try { await transport.startTerminal(terminalId, sessionKey, cwd, cols, rows, terminalHostId); } catch (reason) { setTerminalsBySession((current) => { const session = current[sessionKey]; return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); } finally { startingTerminals.current.delete(terminalId); }
  };
  const addTerminal = () => { const sessionKey = terminalSessionId; setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); if (session.tabs.length >= MAX_TERMINALS) return current; const id = `terminal-${sessionKey}-${crypto.randomUUID()}`; return { ...current, [sessionKey]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; }); };
  const selectTerminal = (terminalId: string) => { const sessionKey = terminalSessionId; setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, activeId: terminalId } }; }); };
  const saveTerminalSnapshot = (sessionKey: string, terminalId: string, snapshot: string, snapshotEnd: number) => { setTerminalsBySession((current) => { const session = current[sessionKey]; if (!session?.tabs.some((terminal) => terminal.id === terminalId)) return current; return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, snapshot, snapshotEnd } : terminal) } }; }); };
  const deleteTerminal = async () => {
    const terminalId = activeTerminal.id; const closingLast = sessionTerminals.tabs.length === 1; const panelTarget = terminalSessionId; const panelRevision = terminalPanelRevision.current;
    if (closingTerminals.current.has(terminalId)) return; closingTerminals.current.add(terminalId);
    try { await transport.closeTerminal(terminalId); } catch (reason) { addNotice({ title: "Could not close terminal", message: reason instanceof Error ? reason.message : String(reason) }); return; }
    finally { closingTerminals.current.delete(terminalId); }
    if (closingLast && terminalSessionIdRef.current === panelTarget && terminalPanelRevision.current === panelRevision) setTerminalOpen(false);
    const sessionKey = panelTarget;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); const removedIndex = session.tabs.findIndex((terminal) => terminal.id === terminalId); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current }; if (!tabs.length) delete next[sessionKey]; else next[sessionKey] = { activeId: tabs[Math.min(Math.max(0, removedIndex), tabs.length - 1)].id, tabs }; return next; });
  };
  const setComposerDraft = (sessionKey: string, value: string) => setComposerDrafts((current) => { if (value) return { ...current, [sessionKey]: value }; const next = { ...current }; delete next[sessionKey]; return next; });
  const setSplitComposerDraft = (value: string) => setComposerDrafts((current) => { if (value) return { ...current, [splitSessionId]: value }; const next = { ...current }; delete next[splitSessionId]; return next; });
  const toggleTerminal = () => { if (!canLeaveSettings()) return; terminalPanelRevision.current += 1; setView("chat"); setTerminalOpen((open) => { if (!open) { const split = activePane === "split" ? splitPane?.session : undefined; setTerminalTarget(split ? { sessionKey: `${split.hostId ?? "local"}:${split.id}`, cwd: split.cwd, hostId: split.hostId ?? "local" } : { sessionKey: activeConversationKeyRef.current, cwd: selectedProjectCwd(activeCwd, transport.isTemporaryChat()), hostId: activeHostIdRef.current }); } return !open; }); };
  const toggleDebugMode = useCallback(() => {
    if (!settings || debugModePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const next = { ...settings, debugMode: !settings.debugMode };
    void transport.saveSettings(next, false).then(() => setSettings(next)).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  }, [addNotice, settings, transport]);
  const reconnectMain = () => {
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
    if (reconnectPending.current.has(ownerTransport)) return; reconnectPending.current.add(ownerTransport); setError(undefined); updateConnected(false);
    void ownerTransport.connect().then(() => ownerTransport.loadSettings()).then((value) => configureRuntime(value)).then(async () => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await refreshSession(); }).then(() => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) { setError(undefined); updateConnected(true); void syncSessionIndex(); } }).catch((reason) => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { reconnectPending.current.delete(ownerTransport); });
  };

  useEffect(() => {
    if (!settings) return;
    const handleKeybind = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector("dialog[open]")) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (!canLeaveSettings()) return;
        setView("chat"); setPanelOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')?.focus(), 0);
        return;
      }
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
  }, [settings, toggleDebugMode, settingsDirty, view, activePane, splitPane]);

  if (!settings) return <main className="app app-loading dark" role={error ? "alert" : "status"}>
    <p className="eyebrow">Pi desktop</p>
    <h1>{error ? "Could not load settings" : "Loading settings…"}</h1>
    {error && <p>{error}</p>}
  </main>;

  const extensionStateIsCurrent = extensionOwner === transport;
  const settingsWithMcpStatuses = { ...settings, mcpServers: settings.mcpServers.map((server) => ({ ...server, ...(extensionStateIsCurrent ? mcpStatuses[server.id] : undefined) })) };
  const activeDialog = dialogs[0];
  const projectCwd = selectedProjectCwd(activeCwd, transport.isTemporaryChat());
  return <div className="app dark">
    {import.meta.env.MODE === "e2e" && <div className="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /></div>}
    <aside className={`icon-rail ${view === "settings" || !panelOpen ? "compact" : ""}`}>{activeBranch && <div className="rail-branch" title={activeBranch}><GitBranch size={13} /><span>{activeBranch}</span></div>}<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="New session group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><IconButton label={settings.debugMode ? "Disable debug mode" : "Enable debug mode"} className={settings.debugMode ? "active" : ""} disabled={debugModeSaving} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label={view === "settings" ? "Go back" : "Settings"} className={view === "settings" ? "active" : ""} onClick={() => { if (view !== "settings") { setView("settings"); return; } if (canLeaveSettings()) setView("chat"); }}>{view === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton></nav>{view === "chat" && panelOpen && <SessionPanel sessions={sessions} activeId={state.sessionId} activeHostId={activeHostId} runningSessions={runningSessions} unseenSessions={unseenSessions} query={query} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} createGroupRequest={createGroupRequest} />}<div className="rail-bottom">{codexUsage !== undefined && <span className="codex-usage" role="status" aria-label={`Codex usage remaining: ${codexUsage.remainingPercent}%${codexUsage.resetAt ? `, resets ${formatCodexReset(codexUsage.resetAt)}` : ""}`} title="Codex usage remaining"><span>{codexUsage.remainingPercent}%<span className="codex-usage-left"> left</span></span>{codexUsage.resetAt && <span className="codex-usage-reset"><span className="codex-usage-separator"> · </span>{formatCodexReset(codexUsage.resetAt)}</span>}</span>}</div></aside>
    <div className="chat-workspace" hidden={view !== "chat"}>
      <div className={`chat-panes ${splitPane ? "split" : ""}`}>
        <ChatView key={activeConversationKey} state={state} messages={messages} gitDiffs={gitDiffs} debug={settings.debugMode} agents={extensionStateIsCurrent ? orchestration?.config.agents ?? [] : []} sequences={extensionStateIsCurrent ? orchestration?.config.sequences ?? [] : []} activeAgent={extensionStateIsCurrent ? orchestration?.active : undefined} dictionaries={settings.dictionaries.filter((item) => settings.activeDictionaryIds.includes(item.id))} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={extensionStateIsCurrent ? Object.values(widgets).flat() : []} statuses={extensionStateIsCurrent ? Object.values(statuses) : []} projectCwd={projectCwd} controlsDisabled={!connected} draft={composerDraft} onDraftChange={(value) => setComposerDraft(activeConversationKey, value)} focusRequest={mainComposerFocusRequest} onActivate={() => setActivePane("main")} uploads={composerUploads} onUploadsChange={(update) => setComposerUploads(transport, update)} onSend={send} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => { terminalPanelRevision.current += 1; setActivePane("main"); setTerminalTarget({ sessionKey: activeConversationKey, cwd: projectCwd, hostId: activeHostId }); setTerminalOpen(true); }} onOpenProject={chooseChatProject} onBranch={branch} onCreateWorktree={isGitRepository && projectCwd ? (message) => setWorktreeTarget({ cwd: projectCwd, hostId: activeHostId, message }) : undefined} onAgent={setAgent} onModel={setModel} onThinking={setThinking} />
        {splitPane && <SplitChatPane key={splitSessionId} runtimePool={runtimePool} session={splitPane.session} settings={settings} draft={splitComposerDraft} onDraftChange={setSplitComposerDraft} focusRequest={splitComposerFocusRequest} onActivate={() => setActivePane("split")} onOpenTerminal={() => { terminalPanelRevision.current += 1; setActivePane("split"); setTerminalTarget({ sessionKey: splitSessionId, cwd: splitPane.session.cwd, hostId: splitPane.session.hostId ?? "local" }); setTerminalOpen(true); }} onDialogRequest={queueExtensionDialog} onDialogTransportClosed={closeTransportDialogs} onReleaseTransport={releaseSplitTransport} forkFrom={splitPane.btw?.forkFrom} initialPrompt={splitPane.btw?.task} onReady={splitPane.btw ? () => respondToBtw(splitPane.btw!.requestId, { value: "opened" }) : undefined} onFailed={splitPane.btw ? () => respondToBtw(splitPane.btw!.requestId, { cancelled: true }) : undefined} onClose={closeSplitPane} />}
      </div>
      {terminalOpen && <TerminalView key={`${terminalSessionId}:${activeTerminal.id}`} cwd={terminalCwd} terminals={sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={activeTerminal.id} output={activeTerminal.output} outputEnd={activeTerminal.outputEnd} snapshot={activeTerminal.snapshot} snapshotEnd={activeTerminal.snapshotEnd} started={activeTerminal.started} exited={activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={(data) => { void transport.writeTerminal(activeTerminal.id, data).catch((reason) => queueTerminalOutput(activeTerminal.id, `\r\nTerminal input failed: ${String(reason)}\r\n`)); }} onResize={(cols, rows) => { void transport.resizeTerminal(activeTerminal.id, cols, rows).catch(() => undefined); }} onSnapshot={(value, outputEnd) => saveTerminalSnapshot(terminalSessionId, activeTerminal.id, value, outputEnd)} onDelete={deleteTerminal} onClose={() => { terminalPanelRevision.current += 1; setTerminalOpen(false); }} />}
    </div>
    {view === "settings" && <SettingsView settings={settingsWithMcpStatuses} orchestration={extensionStateIsCurrent ? orchestration?.config : undefined} sessions={sessions} models={models} thinkingLevels={thinkingLevels} onSave={saveSettings} onDirtyChange={setSettingsDirty} />}
    {(error || notices.length > 0) && <div className="toast-stack">
      {error && <div className="error-toast" role="alert"><strong>Pi could not connect</strong><span>{error}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport)}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
      {notices.map((notice) => <div className="error-toast" role="alert" key={notice.id}><strong>{notice.title}</strong><span>{notice.message}</span><button aria-label={`Dismiss ${notice.title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}>×</button></div>)}
    </div>}
    {activeDialog && !projectOpen && !renameSession && !relocatingSession && !worktreeTarget && <ExtensionDialog key={activeDialog.queueId} request={activeDialog.request} owner={activeDialog.owner} onRespond={async (response) => { await activeDialog.transport.command({ type: "extension_ui_response", id: activeDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== activeDialog)); }} />}
    {projectOpen && <ProjectDialog initialPath={projectCwd ?? ""} hosts={settings.hosts} initialHostId={activeHostId} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport.listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />}
    {renameSession && <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: renameSession.session.name }} onRespond={async (response) => { if (response.cancelled) { setRenameSession(undefined); return; } if (typeof response.value !== "string" || !response.value.trim()) throw new Error("Conversation name can't be empty"); const name = response.value.trim(); await renameSession.transport.connect(); await renameSession.transport.command({ type: "set_session_name", name }); if (renameSession.session.id === state.sessionId && (renameSession.session.hostId ?? "local") === activeHostId) setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}
    {relocatingSession && <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${relocatingSession.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${relocatingSession.cwd}. Enter its new location to open this conversation.`, error: relocationError, placeholder: "Replacement project directory", prefill: sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId && session.cwdExists !== false)?.cwd || "" }} onRespond={async (response) => { if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; } const cwd = typeof response.value === "string" ? response.value.trim() : ""; if (!cwd) { setRelocationError("Path can't be empty"); return; } const session = relocatingSession; const action = relocationActionRef.current; const relocated = { ...session, cwd, cwdExists: true }; setRelocationError(undefined); try { await transport.relocateSession(session.path, cwd, session.hostId); setRelocatingSession(undefined); if (action === "split") openSplitPane(relocated); else if (action === "rename") setRenameSession({ session: relocated, transport: runtimePool.forSession(relocated) }); else selectSession(relocated); } catch (reason) { setRelocationError(reason instanceof Error ? reason.message : String(reason)); } }} />}
    {worktreeTarget && <WorktreeDialog projectPath={worktreeTarget.cwd} onCancel={() => setWorktreeTarget(undefined)} onCreate={async (name) => { const target = worktreeTarget; const result = await transport.createGitWorktree(target.cwd, name, target.hostId); setWorktreeTarget(undefined); try { const branched = await branchConversation(target.message, result.path); if (!branched) throw new Error("Conversation branching was cancelled"); setActiveBranch(result.branch); } catch (reason) { addNotice({ title: "Worktree created, but conversation could not be branched", message: reason instanceof Error ? reason.message : String(reason) }); } return result; }} />}
  </div>;
}
