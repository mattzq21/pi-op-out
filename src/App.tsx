import { Key, Rerun } from "@solid-primitives/keyed";
import { ArrowLeft, Bug, FolderPlus, GitBranch, MessageSquare, Mic, Notebook, Server, Settings } from "lucide-solid";
import { batch, createComputed, createMemo, createSignal, onCleanup } from "solid-js";
import { appendTerminalOutputs, AppLoading, dialogOwnerName, goUsageBadge, initialTerminals, LimitBadge, MAX_TERMINALS, normalizeCodexUsage, normalizeOpencodeGoUsage, selectedProjectCwd, splitConversationKey, terminalConversationKey, useUsageClock, type OwnedExtensionDialog, type QueuedTerminalOutput, type RenameTarget, type SessionTerminals, type SplitPaneState, type TerminalTarget, type WorktreeTarget } from "./appSupport";
import { createBranchConversation } from "./branchConversation";
import { ChatView } from "./components/ChatView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { ConversationQuestionsContext } from "./components/ConversationQuestions";
import { isAskUserRequest } from "./components/AskUserDialog";
import { FindInPage } from "./components/FindInPage";
import { IconButton } from "./components/IconButton";
import { LocalSettingsView } from "./components/LocalSettingsView";
import { NotesPane } from "./components/NotesPane";
import { ProjectDialog } from "./components/ProjectDialog";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { SessionPanel, type SessionAction } from "./components/SessionPanel";
import { SplitChatPane } from "./components/SplitChatPane";
import { SubagentPane } from "./components/SubagentPane";
import { SubagentNavigationContext, type SubagentTarget } from "./lib/subagentNavigation";
import { TerminalView } from "./components/TerminalView";
import { FileWorkspace } from "./components/FileWorkspace";
import { WorktreeDialog } from "./components/WorktreeDialog";
import { encodeAgentValue } from "./lib/agentProtocol";
import { withClientSettings } from "./lib/clientSettings";
import { hasVisibleText, textOf } from "./lib/content";
import { keybindDefinitions, matchesShortcut } from "./lib/keybindings";
import { branchMessages, type PiEntry } from "./lib/messages";
import { recordSeenModels } from "./lib/modelVisibility";
import { initialWindowTarget, NativeTransport, openOrchestratorChat, openSessionWindow } from "./lib/nativeTransport";
import { ORCHESTRATOR_SESSION_ID, VOICE_ORCHESTRATOR_AGENT } from "./lib/orchestrator";
import { isMobile, listen } from "./lib/platform";
import { updateSessionGroups, type SessionGroup } from "./lib/sessionGroups";
import { SessionRuntimePool, useTurnDiffs } from "./lib/sessionRuntimePool";
import { createDependencyEffect, createMemoFields, createRef, createSubscription, type StateUpdate } from "./lib/solid";
import { TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import { useChatSession } from "./lib/useChatSession";
import type { AgentConfig, AgentState, AppSettings, ChatMessage, CodexUsage, ComposerUpload, DefinedAgentsCapability, ExtensionUiRequest, ImageAttachment, Model, OpencodeGoUsage, SessionSummary, SettingsChange, SlashCommand } from "./types";
import { useAppEvents } from "./useAppEvents";
export { formatCodexReset,normalizeCodexUsage,normalizeOpencodeGoUsage,usageWindowsDescription } from "./appSupport";
declare const __PIOP_DEVELOPMENT_BRANCH__: string;
export default function App() {
  const runtimePool = createMemo(() => new SessionRuntimePool()); const [transport, setTransport] = createSignal((() => { const initial = runtimePool().create(initialWindowTarget()); runtimePool().activate(initial); return initial; })()); const [view, setView] = createSignal<"chat" | "settings">("chat");
  const activeTransportRef = createRef(transport()); createComputed(() => { activeTransportRef.current = transport(); });
  const pendingSessionGroups = createRef(new WeakMap<NativeTransport, string>());
  const initialConversationKey = createRef(`local:draft-${crypto.randomUUID()}`);
  const [activeConversationKey, setActiveConversationKey] = createSignal(initialConversationKey.current);
  const activeConversationKeyRef = createRef(activeConversationKey()); createComputed(() => { activeConversationKeyRef.current = activeConversationKey(); });
  const transportConversationKeys = createRef(new Map<NativeTransport, string>([[transport(), initialConversationKey.current]]));
  const liveSessionRevision = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().liveSessionRevision());
  const liveSessions = createMemo(() => { liveSessionRevision(); return runtimePool().liveSessionSummaries(); });
  const runningSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().runningSessions());
  const unseenSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().unseenSessions());
  const pendingSettingsCount = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().pendingSettingsCount());
  const gitDiffs = useTurnDiffs(() => (runtimePool()), () => (transport()));
  const sessionRuntime = useChatSession(() => (transport())); const chatSession = createMemo(() => (sessionRuntime));
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]); const [settings, setSettings] = createSignal<AppSettings>();
  const runtimeSettings = createRef<AppSettings | undefined>(undefined);
  const applyRuntimeSettings = (next: AppSettings) => {
    const previous = runtimeSettings.current;
    runtimeSettings.current = next;
    if (previous) runtimePool().queueSettingsChange(previous, next);
  };
  const [definedAgents, setDefinedAgents] = createSignal<DefinedAgentsCapability>();
  const [openingOrchestrator, setOpeningOrchestrator] = createSignal(false);
  const isOrchestrator = () => activeHostId() === "local" && chatSession().state.sessionId === ORCHESTRATOR_SESSION_ID;
  const settingsSavePending = createRef(false); const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [debugModeSaving, setDebugModeSaving] = createSignal(false);
  const debugModePending = createRef(false);
  const [settingsDirty, setSettingsDirty] = createSignal(false);
  const settingsDirtyRef = createRef(settingsDirty()); createComputed(() => { settingsDirtyRef.current = settingsDirty(); });
  const sessionIndexRequest = createRef<Promise<void> | undefined>(undefined);
  const [panelOpen, setPanelOpen] = createSignal((() => !window.matchMedia("(max-width: 700px)").matches)()); const [query, setQuery] = createSignal(""); const [connected, setConnected] = createSignal(false); const connectionReadyRef = createRef(connected()); createComputed(() => { connectionReadyRef.current = connected(); }); const updateConnected = (value: boolean) => { const owned = value && activeTransportRef.current.ownsConversation(); connectionReadyRef.current = owned; setConnected(owned); }; const [error, setError] = createSignal<string>();
  const [createGroupRequest, setCreateGroupRequest] = createSignal(0);
  const handleCreateGroup = () => setCreateGroupRequest(0);
  const [activeHostId, setActiveHostId] = createSignal((() => transport().currentHostId())());
  const [activeCwd, setActiveCwd] = createSignal<string | undefined>((() => transport().currentCwd())());
  const [isGitRepository, setIsGitRepository] = createSignal<boolean>();
  const activeHostIdRef = createRef(activeHostId()); createComputed(() => { activeHostIdRef.current = activeHostId(); });
  const [codexUsage, setCodexUsage] = createSignal<CodexUsage>();
  const [opencodeGoUsage, setOpencodeGoUsage] = createSignal<OpencodeGoUsage>();
  const [usageClock, setUsageClock] = createSignal(0);
  const opencodeGoBadge = createMemo(() => { usageClock(); return goUsageBadge(opencodeGoUsage()); });
  const [dialogs, setDialogs] = createSignal<OwnedExtensionDialog[]>([]); const [notices, setNotices] = createSignal<Array<{ id: string; title: string; message: string }>>([]);
  const dialogsRef = createRef(dialogs()); createComputed(() => { dialogsRef.current = dialogs(); });
  const mainDialogOwnerRef = createRef("Main conversation"); createComputed(() => { mainDialogOwnerRef.current = dialogOwnerName(chatSession().state.sessionName); });
  const addNotice = (notice: { title: string; message: string }) => setNotices((current) => [...current.slice(-9), { ...notice, id: crypto.randomUUID() }]);
  const queueExtensionDialog = (request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => setDialogs((current) => current.some((dialog) => dialog.transport === ownerTransport && dialog.request.id === request.id) ? current : [...current, { request, transport: ownerTransport, owner, queueId: crypto.randomUUID() }]);
  const resolveExtensionDialog = (owner: NativeTransport, id: string) => setDialogs((current) => current.filter((dialog) => dialog.transport !== owner || dialog.request.id !== id));
  const closeTransportDialogs = async (ownerTransport: NativeTransport) => {
    setDialogs((current) => current.filter((dialog) => dialog.transport !== ownerTransport));
  };
  const hasRetainedDraft = (ownerTransport: NativeTransport) => {
    const key = transportConversationKeys.current.get(ownerTransport);
    return Boolean(key && composerDrafts()[key]) || runtimePool().liveSessionSummaries().some(session => session.isDraft && `${session.hostId ?? "local"}:${session.id}` === key);
  };
  const releaseSplitTransport = async (ownerTransport: NativeTransport) => { const capturedRuntimePool = runtimePool();
    // Selecting a split conversation transfers its runtime to the main pane.
    if (activeTransportRef.current === ownerTransport) return;
    await closeTransportDialogs(ownerTransport);
    if (!ownerTransport.isEphemeral() && hasRetainedDraft(ownerTransport)) return;
    if (ownerTransport.currentSessionPath() && (uploadsByTransport().get(ownerTransport)?.length ?? 0) > 0) return;
    if (activeTransportRef.current !== ownerTransport) await capturedRuntimePool.release(ownerTransport);
  };
  const [statuses, setStatuses] = createSignal<Record<string, string>>({}); const [widgets, setWidgets] = createSignal<Record<string, string[]>>({});
  const [extensionOwner, setExtensionOwner] = createSignal(transport());
  const [renameSession, setRenameSession] = createSignal<RenameTarget>();
  const [projectOpen, setProjectOpen] = createSignal(false);
  const [worktreeTarget, setWorktreeTarget] = createSignal<WorktreeTarget>();
  const projectOpenRef = createRef(projectOpen()); createComputed(() => { projectOpenRef.current = projectOpen(); });
  const projectOpenRequest = createRef(0);
  const [relocatingSession, setRelocatingSession] = createSignal<SessionSummary>(); const [relocationError, setRelocationError] = createSignal<string>();
  const relocationActionRef = createRef<"select" | "split" | "rename">("select");
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [notesOpen, setNotesOpen] = createSignal(false);
  const toggleNotes = (open: boolean) => setNotesOpen(open);
  const [terminalTarget, setTerminalTarget] = createSignal<TerminalTarget>();
  const [composerDrafts, setComposerDrafts] = createSignal<Record<string, string>>({});
  const [uploadsByTransport, setUploadsByTransport] = createSignal<Map<NativeTransport, ComposerUpload[]>>((() => new Map())());
  const newSessionPending = createRef(false);
  const abortPending = createRef(new Set<NativeTransport>());
  const pauseResumePending = createRef(new Set<NativeTransport>());
  const branchPending = createRef(new Set<string>());
  const archivePending = createRef(new Set<string>());
  const archivedSessionKeys = createRef(new Set<string>());
  const sessionActionPending = createRef(new Set<string>());
  const [splitPane, setSplitPane] = createSignal<SplitPaneState>();
  const [subagentPane, setSubagentPane] = createSignal<SubagentTarget>();
  const hasSidePane = () => Boolean(splitPane() || subagentPane());
  createDependencyEffect(() => { if (splitPane()) setSubagentPane(undefined); }, () => [splitPane()]);
  const [mainComposerFocusRequest, setMainComposerFocusRequest] = createSignal(0);
  const [splitComposerFocusRequest, setSplitComposerFocusRequest] = createSignal(0);
  const [activePane, setActivePane] = createSignal<"main" | "split">("main");
  const pendingBtwRequest = createRef<{ id: string; transport: NativeTransport } | undefined>(undefined);
  const [terminalsBySession, setTerminalsBySession] = createSignal<Record<string, SessionTerminals>>({});
  const closingTerminals = createRef(new Set<string>());
  const startingTerminals = createRef(new Set<string>());
  const terminalPanelRevision = createRef(0);
  const controlQueues = createRef(new WeakMap<NativeTransport, Promise<void>>());
  const reconnectPending = createRef(new Set<NativeTransport>());
  const queuedTerminalOutput = createRef(new Map<string, QueuedTerminalOutput>()); const terminalOutputFrame = createRef<number | undefined>(undefined);
  const terminalLocation = () => {
    const terminalCwd = terminalTarget()?.cwd ?? activeCwd() ?? sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.cwd;
    const terminalHostId = terminalTarget()?.hostId ?? activeHostId();
    return { terminalCwd, terminalHostId };
  };
  const splitSessionId = createMemo(() => (splitConversationKey(splitPane())));
  const terminalSessionId = createMemo(() => (terminalConversationKey(terminalTarget(), activeConversationKey())));
  const terminalSessionIdRef = createRef(terminalSessionId()); createComputed(() => { terminalSessionIdRef.current = terminalSessionId(); });
  const terminalLocationState = createMemo(() => (terminalLocation()));
  const composerAndTerminalState = () => {
    const composerDraft = composerDrafts()[activeConversationKey()] ?? "";
    const composerUploads = uploadsByTransport().get(transport()) ?? [];
    const splitComposerDraft = composerDrafts()[splitSessionId()] ?? "";
    const sessionTerminals = terminalsBySession()[terminalSessionId()] ?? initialTerminals(terminalSessionId());
    const activeTerminal = sessionTerminals.tabs.find((terminal) => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];
    return { composerDraft, composerUploads, splitComposerDraft, sessionTerminals, activeTerminal };
  };
  const composerFields = createMemoFields(composerAndTerminalState);
  const composerState = () => composerFields;
  const terminalViewKey = createMemo(() => `${terminalSessionId()}:${composerState().activeTerminal.id}`);
  const terminalsBySessionRef = createRef(terminalsBySession()); createComputed(() => { terminalsBySessionRef.current = terminalsBySession(); });
  const activateConversationKey = (key: string) => { activeConversationKeyRef.current = key; setActiveConversationKey(key); };
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool();
 capturedRuntimePool.setErrorHandler((message) => addNotice({ title: message.startsWith("Could not load saved project changes") || message.startsWith("Could not save project changes") ? "Project changes" : "Session", message })); return () => { capturedRuntimePool.setErrorHandler(); }; }, () => [addNotice, runtimePool()]);
  const flushTerminalOutput = () => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();
    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  };
  const queueTerminalOutput = (terminalId: string, data: string) => {
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });
    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = window.setTimeout(flushTerminalOutput, 0);
  };
  createDependencyEffect(() => {
    const capturedTransport = transport();
 let cancelled = false; const load = () => { void capturedTransport.loadCodexUsage().then((usage) => { if (!cancelled) setCodexUsage(normalizeCodexUsage(usage)); }).catch(() => undefined); void capturedTransport.loadOpencodeGoUsage().then((usage) => { if (!cancelled) setOpencodeGoUsage(normalizeOpencodeGoUsage(usage)); }).catch(() => undefined); }; load(); const interval = window.setInterval(load, 60_000); window.addEventListener("focus", load); return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener("focus", load); }; }, () => [transport()]);
  createDependencyEffect(() => { const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const previousKey = activeConversationKeyRef.current;
    if (!capturedSession.state.sessionId || !previousKey.includes(":draft-")) return;
    const canonicalKey = `${capturedActiveHostId}:${capturedSession.state.sessionId}`;
    if (previousKey === canonicalKey) return;
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    transportConversationKeys.current.set(capturedTransport, canonicalKey); activateConversationKey(canonicalKey);
  }, () => [activeHostId(), chatSession().state.sessionId, transport()]);
  createDependencyEffect(() => { const capturedTransport = transport();
    let cancelled = false;
    setIsGitRepository(undefined);
    void capturedTransport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, () => [transport(), sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.projectKind]);
  useUsageClock(() => (codexUsage()), () => (opencodeGoUsage()), () => (setUsageClock));
  createDependencyEffect(() => { const capturedSettings = settings(); const capturedSession = { ...chatSession() }; const capturedTransport = transport();
    if (!capturedSettings || capturedSession.models.length === 0 || settingsSavePending.current) return;
    const next = recordSeenModels((capturedSettings)!, capturedSession.models.map((model) => `${model.provider}/${model.id}`));
    if (!next) return;
    void capturedTransport.saveSettings(next, false).then((change) => { if (change?.settings) setSettings(change.settings); }).catch(() => undefined);
  }, () => [chatSession().models, settings(), transport()]);
  const syncSessionIndex = () => {
    if (!sessionIndexRequest.current) sessionIndexRequest.current = transport().listSessions().then((nextSessions) => {
      setSessions(nextSessions.filter((session) => !runtimePool().isRemoved(session) && !archivedSessionKeys.current.has(`${session.hostId ?? "local"}:${session.id}`)));
      chatSession().setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId && (session.hostId ?? "local") === activeHostIdRef.current);
        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch(() => undefined).finally(() => { sessionIndexRequest.current = undefined; });
    return sessionIndexRequest.current;
  };
  createDependencyEffect(() => {
    const unsubscribes = [
      listen("pi://sessions-changed", () => { void syncSessionIndex(); }),
      listen<{ hostId?: string; sessionPath: string }>("pi://session-removed", ({ payload }) => {
        runtimePool().removeSummary(payload.hostId ?? "local", payload.sessionPath);
        setSessions((current) => current.filter((session) => !runtimePool().isRemoved(session)));
        void syncSessionIndex();
      }),
      listen<{ hostId: string; line: string }>("pi://daemon-error", ({ payload }) => addNotice({ title: `Connection · ${payload.hostId}`, message: payload.line })),
    ];
    return () => { for (const pending of unsubscribes) void pending.then((unlisten) => unlisten()); };
  }, () => [addNotice, syncSessionIndex]);
  createDependencyEffect(() => {
    const pending = listen<SettingsChange>("pi://settings-changed", ({ payload }) => {
      const next = withClientSettings(payload.settings);
      applyRuntimeSettings(next);
      setSettings(next);
    });
    const updateClientPreferences = (event: StorageEvent) => {
      if (event.key !== "piop-client-settings") return;
      setSettings((current) => current ? withClientSettings(current) : current);
    };
    window.addEventListener("storage", updateClientPreferences);
    return () => { void pending.then((unlisten) => unlisten()); window.removeEventListener("storage", updateClientPreferences); };
  }, () => [applyRuntimeSettings]);
  const refresh = async (hostId?: string) => { const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool();
    void syncSessionIndex();
    const settingsRequest = capturedTransport.loadSettings().then((nextSettings) => { if (activeTransportRef.current !== capturedTransport) throw new Error("Conversation changed"); applyRuntimeSettings(nextSettings); setSettings(nextSettings); return nextSettings; });
    const [nextState, nextSettings] = await Promise.all([capturedSession.refresh(), settingsRequest]); capturedRuntimePool.bind(hostId ?? capturedTransport.currentHostId(), nextState.sessionId, capturedTransport);
    const group = pendingSessionGroups.current.get(capturedTransport);
    if (group && nextState.sessionId) {
      try {
        await updateSessionGroups({ type: "assign", key: `${hostId ?? capturedTransport.currentHostId()}:${nextState.sessionId}`, group });
        pendingSessionGroups.current.delete(capturedTransport);
      } catch (reason) { addNotice({ title: "Could not add chat to group", message: String(reason) }); }
    }
    return nextSettings;
  };
  const projectControls = new WeakMap<NativeTransport, { agent?: string; model: Model | null; thinking: string }>();
  const configureRuntime = async (value: AppSettings) => { const capturedTransport = transport();
    const current = () => activeTransportRef.current === capturedTransport;
    if (!current() || !capturedTransport.ownsConversation()) return;
    if (capturedTransport.currentHostId() !== "local") value = await capturedTransport.loadHostSettings();
    if (!current()) return;
    const [modelResult] = await Promise.allSettled([
      capturedTransport.command<{ models: Model[] }>({ type: "get_available_models" }),
      capturedTransport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
    ]);
    if (!current()) return;
    await Promise.all([
      capturedTransport.command({ type: "set_auto_compaction", enabled: true }),
      capturedTransport.command({ type: "set_auto_retry", enabled: value.autoRetry }),
    ]);
    if (!current()) return;
    const availableModels = modelResult.status === "fulfilled" ? modelResult.value.models : [];
    const inherited = projectControls.get(capturedTransport);
    if (inherited) {
      if (inherited.agent) await capturedTransport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(inherited.agent === VOICE_ORCHESTRATOR_AGENT ? "general" : inherited.agent)}` });
      if (inherited.model && availableModels.some((model) => model.provider === inherited.model!.provider && model.id === inherited.model!.id)) await capturedTransport.command({ type: "set_model", provider: inherited.model.provider, modelId: inherited.model.id });
      const { levels } = await capturedTransport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" });
      if (levels.includes(inherited.thinking)) await capturedTransport.command({ type: "set_thinking_level", level: inherited.thinking });
      projectControls.delete(capturedTransport); capturedTransport.defaultsApplied();
      return;
    }
    if (capturedTransport.needsDefaults()) {
      const defaultModel = availableModels.find((model) => `${model.provider}/${model.id}` === value.defaultModel);
      if (defaultModel) await capturedTransport.command({ type: "set_model", provider: defaultModel.provider, modelId: defaultModel.id });
      if (!current()) return;
      const { levels } = await capturedTransport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" });
      if (!current()) return;
      if (levels.includes(value.defaultThinking)) await capturedTransport.command({ type: "set_thinking_level", level: value.defaultThinking });
      if (!current()) return;
      await capturedTransport.setFastMode(value.defaultFastMode);
      if (!current()) return;
      await capturedTransport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(value.defaultAgent === VOICE_ORCHESTRATOR_AGENT ? "general" : value.defaultAgent ?? "general")}` });
      capturedTransport.defaultsApplied();
    }
  };
  const btwImages = new WeakMap<NativeTransport, ImageAttachment[]>();
  const resolveHomeDirectory = (hostId: string) => transport().homeDirectory(hostId);
  useAppEvents(() => ({ transport: transport(), handleEvent: chatSession().handleEvent, setDialogs, refresh, queueTerminalOutput, setTerminalsBySession, addNotice, activeTransportRef, pendingBtwRequest, btwImages, setSplitPane, activeHostIdRef, setExtensionOwner, setDefinedAgents, refreshSession: chatSession().refresh, setStatuses, setWidgets, setComposerDrafts, transportConversationKeys, terminalSessionIdRef, setActivePane, setMainComposerFocusRequest, queueExtensionDialog, mainDialogOwnerRef, setActiveHostId, setActiveCwd, activateConversationKey, setTerminalOpen, setTerminalTarget, configureRuntime, setError, updateConnected, terminalOutputFrame, flushTerminalOutput }));
  createDependencyEffect(() => {
    const capturedTransport = transport(); const capturedRuntimePool = runtimePool();
 const shutdown = () => { for (const session of Object.values(terminalsBySessionRef.current)) for (const terminal of session.tabs) void capturedTransport.closeTerminal(terminal.id).catch(() => undefined); void capturedRuntimePool.disconnectAll(); }; window.addEventListener("pagehide", shutdown); return () => window.removeEventListener("pagehide", shutdown); }, () => [runtimePool(), transport()]);
  createDependencyEffect(() => {
    const capturedSettingsDirty = settingsDirty();
 if (!capturedSettingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, () => [settingsDirty()]);
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool(); const capturedView = view(); const capturedTransport = transport();
 capturedRuntimePool.activate(capturedView === "chat" ? capturedTransport : undefined); }, () => [runtimePool(), transport(), view()]);
  createDependencyEffect(() => { const capturedConnected = connected(); const capturedSettings = settings();
    if (!capturedConnected || !capturedSettings) return;
    const interval = window.setInterval(() => void syncSessionIndex(), (capturedSettings)!.hosts.length ? 5000 : 1500);
    return () => window.clearInterval(interval);
  }, () => [connected(), settings(), syncSessionIndex]);
  const parseBranchCommand = (branchCommand: RegExpExecArray) => {
    const [, command, rawArgs = ""] = branchCommand;
    const args = rawArgs.trim().split(/\s+/).filter(Boolean);
    const hasNumber = args.length > 0 && /^[+-]?\d/.test(args[0]);
    const number = hasNumber ? args.shift()! : "0";
    if (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error("The response number must be a non-negative integer");
    if (command === "branch-off" && args.length) throw new Error("Usage: /branch-off [number]");
    const responses = chatSession().messages.filter((message) => message.role === "assistant" && message.entryId && !message.streaming && message.stopReason !== "toolUse" && (message.stopReason === "aborted" || message.stopReason === "error" || (typeof message.content === "string" ? message.content.trim() : message.content.some((part) => part.type === "text" && part.text?.trim()))));
    const message = responses.at(-1 - Number(number));
    if (!message) throw new Error(`No response exists ${number} responses back`);
    return { command, args, message };
  };
  const sendBranchCommand = async (branchCommand: RegExpExecArray, images: ImageAttachment[]) => { const capturedSession = { ...chatSession() }; const capturedBranchConversation = branchConversation(); const capturedIsGitRepository = isGitRepository(); const capturedProjectCwd = projectCwd(); const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    if (images.length) throw new Error("Branch commands do not accept attachments");
    if (capturedSession.state.isStreaming || capturedSession.state.isPausing) throw new Error("Stop or pause the agent before branching");
    const { command, args, message } = parseBranchCommand(branchCommand);
    if (command === "branch-off") return capturedBranchConversation(message);
    if (!capturedIsGitRepository || !capturedProjectCwd) throw new Error("Open a Git project before creating a worktree");
    const target = { cwd: (capturedProjectCwd)!, hostId: capturedActiveHostId, message, transport: capturedTransport };
    if (!args.length) { setWorktreeTarget(target); return true; }
    await createWorktree(target, args.join(" "));
    return true;
  };
  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => { const capturedTransport = transport();
    if (!connectionReadyRef.current) throw new Error("piop is still connecting");
    const ownerTransport = capturedTransport; const ownerKey = activeConversationKeyRef.current;
    if (/^\/btw(?:\s|$)/.test(text.trim())) btwImages.set(capturedTransport, images);
    const branchCommand = /^\/(worktree|branch-off)(?:\s+(.*))?$/s.exec(text.trim());
    if (branchCommand) {
      return sendBranchCommand(branchCommand, images);
    }
    try {
    if (behavior) { await ownerTransport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); return; }
    await capturedTransport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
    return true;
    } catch (reason) { addNotice({ title: "Could not send message", message: reason instanceof Error ? reason.message : String(reason) }); throw reason; }
  };
  const respondToBtw = (requestId: string, response: { value?: string; cancelled?: boolean }) => {
    const pending = pendingBtwRequest.current; if (!pending || pending.id !== requestId) return;
    pendingBtwRequest.current = undefined;
    void pending.transport.command({ type: "extension_ui_response", id: requestId, ...response }).catch((reason) => addNotice({ title: "Could not finish /btw request", message: reason instanceof Error ? reason.message : String(reason) }));
  };
  const closeSplitPane = () => { if (splitPane()?.btw) respondToBtw((splitPane())!.btw!.requestId, { cancelled: true }); setSplitPane(undefined); setSubagentPane(undefined); setActivePane("main"); };
  const openSubagent = (target: SubagentTarget) => { closeSplitPane(); setSubagentPane(target); setActivePane("split"); };
  const canLeaveSettings = () => view() !== "settings" || !settingsDirty() || window.confirm("Discard unsaved settings changes?");
  const setComposerUploads = (ownerTransport: NativeTransport, update: StateUpdate<ComposerUpload[]>) => setUploadsByTransport((current) => {
    const next = new Map(current);
    const uploads = typeof update === "function" ? update(next.get(ownerTransport) ?? []) : update;
    if (uploads.length) next.set(ownerTransport, uploads); else next.delete(ownerTransport);
    return next;
  });
  const transportHasDraft = (owner: NativeTransport, key?: string) => Boolean(key && composerDrafts()[key]) || (uploadsByTransport().get(owner)?.length ?? 0) > 0;
  const conversationTerminalIds = (key: string) => terminalsBySession()[key]?.tabs.map((terminal) => terminal.id) ?? [];
  const activateTransport = (nextTransport: NativeTransport) => {
    const previousTransport = transport();
    const previousKey = transportConversationKeys.current.get(previousTransport);
    const hasUnsentWork = transportHasDraft(previousTransport, previousKey) || previousTransport.hasTerminalActivity() || Boolean(previousKey && conversationTerminalIds(previousKey).length);
    if (previousTransport !== nextTransport && previousKey && hasUnsentWork && !runtimePool().isRetained(previousTransport) && chatSession().state.messageCount === 0 && chatSession().messages.length === 0) {
      const hostId = previousTransport.currentHostId(); const id = previousKey.slice(hostId.length + 1); const draft = composerDrafts()[previousKey] ?? ""; const cwd = previousTransport.currentCwd() ?? "";
      runtimePool().bind(hostId, id, previousTransport);
      runtimePool().setLiveSession(previousTransport, { id, hostId, isDraft: true, path: previousTransport.currentSessionPath() ?? "", cwd, project: cwd.split("/").filter(Boolean).at(-1) ?? "Workspace", name: hasVisibleText(draft) ? draft.slice(0, 60) : "Unsent draft", preview: draft, messageCount: 0, lastMessageAt: Date.now(), apiCost: 0 });
    }
    const discardPrevious = previousTransport !== nextTransport && !runtimePool().isRetained(previousTransport) && !chatSession().state.isStreaming && chatSession().state.messageCount === 0 && chatSession().messages.length === 0 && !hasUnsentWork;
    activeTransportRef.current = nextTransport; runtimePool().activate(nextTransport); setTransport(nextTransport);
    if (discardPrevious) {
      setUploadsByTransport((current) => { const next = new Map(current); next.delete(previousTransport); return next; });
      if (previousKey) {
        setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
        const terminalIds = conversationTerminalIds(previousKey);
        if (terminalIds.length) void Promise.allSettled(terminalIds.map((id) => previousTransport.closeTerminal(id)));
        setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
      }
      void runtimePool().release(previousTransport).finally(() => transportConversationKeys.current.delete(previousTransport));
    }
  };
  onCleanup(() => {
    for (const session of Object.values(terminalsBySessionRef.current)) for (const terminal of session.tabs) void activeTransportRef.current.closeTerminal(terminal.id).catch(() => undefined);
    void runtimePool().disconnectAll();
  });
  const rekeyConversationUi = (previousKey: string, nextKey: string, ownerTransport: NativeTransport, moveTerminals = true, copyDraft = false) => {
    if (previousKey === nextKey) return;
    if (moveTerminals) for (const terminal of terminalsBySession()[previousKey]?.tabs ?? []) {
      if (terminal.started) void ownerTransport.reassignTerminal(terminal.id, nextKey).catch((reason) => addNotice({ title: "Could not move terminal history", message: String(reason) }));
    }
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; if (!copyDraft) delete next[previousKey]; return next; });
    if (moveTerminals) setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; delete next[previousKey]; return next; });
    if (moveTerminals) setTerminalTarget((current) => current?.sessionKey === previousKey ? { ...current, sessionKey: nextKey } : current);
    transportConversationKeys.current.set(ownerTransport, nextKey);
    if (ownerTransport === activeTransportRef.current) activateConversationKey(nextKey);
  };
  const branchConversation = createMemo(() => (createBranchConversation({ transport: transport(), activeConversationKeyRef, branchPending, state: chatSession().state, sessions: sessions(), runtimePool: runtimePool(), messages: chatSession().messages, rekeyConversationUi, activeTransportRef, setActiveCwd, setTerminalOpen, setTerminalTarget, setState: chatSession().setState, setMessages: chatSession().setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, addNotice, syncSessionIndex })));
  const createWorktree = async (target: WorktreeTarget, name: string, onSetup?: (cancel: (() => Promise<void>) | undefined) => void) => { const capturedSettings = settings(); const capturedRuntimePool = runtimePool();
    const addWorktreeGroup = async (result: { path: string; branch: string; sessionId?: string }) => {
      try {
        await updateSessionGroups({
          type: "project", project: {
            id: `${target.hostId}:${result.path}`, name: result.branch, cwd: result.path,
            hostId: target.hostId, hostName: capturedSettings?.hosts.find((host) => host.id === target.hostId)?.name ?? (target.hostId === "local" ? "Local" : target.hostId),
            projectKind: "worktree",
          }, key: result.sessionId ? `${target.hostId}:${result.sessionId}` : undefined
        });
      } catch (reason) {
        addNotice({ title: "Worktree created, but could not add its group", message: `${result.path}\n${String(reason)}` });
      }
    };
    const setup = async (path: string) => {
      try { await target.transport.runWorktreeSetup(target.cwd, path, target.hostId, onSetup); return true; }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        addNotice({ title: message === "Environment setup cancelled" ? "Environment setup cancelled; worktree kept" : "Worktree created, but environment setup failed", message: `${path}\n${message}` });
        return false;
      }
    };
    if (!target.message) {
      const result = await target.transport.createProjectWorktree(target.cwd, name, target.hostId);
      await addWorktreeGroup(result);
      await setup(result.path);
      setWorktreeTarget(undefined);
      return result;
    }
    const sourceMessage = target.message;
    const owner = target.transport;
    const beforePrompt = sourceMessage.role === "user";
    const history = await owner.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" });
    const message = branchMessages(history.entries, history.leafId).find((message) => message.role === sourceMessage.role && (sourceMessage.entryId ? message.entryId === sourceMessage.entryId : message.timestamp === sourceMessage.timestamp && textOf(message.content) === textOf(sourceMessage.content)));
    if (!message?.entryId) throw new Error("Could not find the message in the saved conversation");
    const result = await owner.command<{ branch: string; path: string; sessionPath: string; sessionId: string }>({ type: "branch_checkpoint", entryId: message.entryId, name, afterResponse: !beforePrompt });
    await addWorktreeGroup(result);
    await setup(result.path);
    setWorktreeTarget(undefined);
    const session: SessionSummary = { id: result.sessionId, path: result.sessionPath, cwd: result.path, cwdExists: true, projectKind: "worktree", project: result.branch, name: result.branch, preview: "", messageCount: 0, lastMessageAt: 0, apiCost: 0, hostId: target.hostId };
    setSessions((current) => [...current, session]);
    setComposerDraft(`${target.hostId}:${result.sessionId}`, beforePrompt ? textOf(sourceMessage.content) : "");
    const branchTransport = capturedRuntimePool.forSession(session);
    setComposerUploads(branchTransport, beforePrompt && Array.isArray(sourceMessage.content) ? sourceMessage.content.flatMap((part) => part.type === "image" && part.data && part.mimeType ? [{ id: crypto.randomUUID(), name: "Attached image", kind: "image" as const, byteSize: Math.ceil(part.data.length * 3 / 4), image: { type: "image" as const, data: part.data, mimeType: part.mimeType } }] : []) : []);
    selectSession(session);
    void syncSessionIndex();
    return result;
  };
  const deleteWorktree = async (cwd: string, hostId: string, deleteBranch: boolean) => { const capturedTransport = transport();
    const result = await capturedTransport.removeGitWorktree(cwd, hostId, deleteBranch);
    if (result.warning) addNotice({ title: "Worktree deleted with a warning", message: result.warning });
    void syncSessionIndex();
  };
  const branch = async (message: ChatMessage) => {
    const capturedBranchConversation = branchConversation();
 try { await capturedBranchConversation(message); } catch (reason) { addNotice({ title: "Could not branch conversation", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const conversationBusy = () => chatSession().state.isStreaming || chatSession().state.isPausing || chatSession().state.pendingMessageCount;
  const forkAndForget = async (message: ChatMessage) => { const capturedTransport = transport(); const capturedSession = { ...chatSession() };
    const ownerTransport = capturedTransport; const ownerKey = activeConversationKeyRef.current;
    const entryId = message.entryId;
    if (!entryId) { addNotice({ title: "Could not fork and forget", message: "Could not find the selected assistant response" }); return; }
    const pendingKey = `${ownerKey}:forget:${entryId}`;
    if (branchPending.current.has(pendingKey)) return;
    branchPending.current.add(pendingKey);
    try {
      if (conversationBusy()) throw new Error("Wait for the current response and queued messages to finish first");
      const result = await ownerTransport.command<{ cancelled?: boolean }>({ type: "fork_and_forget", entryId });
      if (result.cancelled) return;
      const [nextState, history] = await Promise.all([
        ownerTransport.command<AgentState>({ type: "get_state" }),
        ownerTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }),
      ]);
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) {
        capturedSession.discardPendingUpdates(); capturedSession.setState(nextState); capturedSession.setMessages(branchMessages(history.entries, history.leafId));
      }
      void syncSessionIndex();
    } catch (reason) { addNotice({ title: "Could not fork and forget", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { branchPending.current.delete(pendingKey); }
  };
  const confirmNewSession = (clearProject: boolean) => clearProject || !(hasVisibleText(composerState().composerDraft) || composerState().composerUploads.length) || window.confirm("Start a new conversation and discard the unsent draft?");
  const canStartNewSession = (clearProject: boolean) => !newSessionPending.current && canLeaveSettings() && confirmNewSession(clearProject);
  const newSessionTarget = (clearProject: boolean, group?: SessionGroup) => ({ hostId: group ? group.hostId ?? "local" : activeHostIdRef.current, projectCwd: group ? group.cwd ?? undefined : clearProject || isOrchestrator() ? undefined : selectedProjectCwd(activeCwd(), transport().isTemporaryChat()) });
  const createSessionTransport = (cwd: string | undefined, hostId: string) => runtimePool().create(cwd ? { cwd, hostId } : { hostId });
  const startNewSession = async (clearProject = false, group?: SessionGroup) => {
    if (!canStartNewSession(clearProject)) return;
    const ownerTransport = transport(); const ownerKey = activeConversationKeyRef.current;
    const isCurrent = () => activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey;
    const capturedSession = { ...chatSession() }; const pool = runtimePool(); const draft = { ...composerState() };
    const { hostId, projectCwd } = newSessionTarget(clearProject, group);
    const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
    const nextTransport = createSessionTransport(projectCwd, hostId);
    let activated = false;
    newSessionPending.current = true;
    try {
      const cwd = projectCwd ? await nextTransport.validateProjectDirectory(projectCwd, hostId) : await nextTransport.prepareTemporaryChat(hostId);
      if (!isCurrent()) return;
      transportConversationKeys.current.set(nextTransport, conversationKey);
      if (group) pendingSessionGroups.current.set(nextTransport, group.id);
      batch(() => {
        if (clearProject) {
          setComposerDraft(conversationKey, composerState().composerDraft);
          setComposerUploads(nextTransport, composerState().composerUploads);
        } else {
          if (composerState().composerDraft === draft.composerDraft) setComposerDraft(ownerKey, "");
          if (composerState().composerUploads === draft.composerUploads) setComposerUploads(ownerTransport, []);
        }
        setView("chat"); closeSplitPane(); setTerminalOpen(false); setTerminalTarget(undefined);
        updateConnected(false); setDefinedAgents(undefined); capturedSession.discardPendingUpdates();
        setActiveCwd(cwd); setActiveHostId(hostId); activateTransport(nextTransport); activateConversationKey(conversationKey);
      });
      activated = true;
    } catch (reason) {
      if (isCurrent()) {
        addNotice({ title: "Could not start a new conversation", message: reason instanceof Error ? reason.message : String(reason) });
      }
    } finally {
      newSessionPending.current = false;
      if (!activated) {
        transportConversationKeys.current.delete(nextTransport); pendingSessionGroups.current.delete(nextTransport);
        void pool.release(nextTransport).catch((reason) => addNotice({ title: "Could not clean up the new conversation", message: String(reason) }));
      }
    }
  };
  const newSession = () => startNewSession();
  const showOrchestrator = async () => {
    if (openingOrchestrator() || !canLeaveSettings()) return;
    setOpeningOrchestrator(true);
    try {
      const session = await openOrchestratorChat();
      setView("chat");
      closeSplitPane();
      selectSession(session);
    } catch (reason) { addNotice({ title: "Could not open Orchestrator", message: String(reason) }); }
    finally { setOpeningOrchestrator(false); }
  };
  const clearChatProject = () => startNewSession(true);
  const isSplitSession = (session: SessionSummary) => splitPane()?.session.id === session.id && ((splitPane())!.session.hostId ?? "local") === (session.hostId ?? "local");
  const isSelectedSession = (session: SessionSummary) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId();
  const selectSession = (session: SessionSummary) => {
    if (!canLeaveSettings()) return undefined;
    if (window.matchMedia("(max-width: 700px)").matches) setPanelOpen(false);
    const selectedKey = `${session.hostId ?? "local"}:${session.id}`; if (archivePending.current.has(selectedKey)) return undefined;
    const hostId = session.hostId ?? "local"; if (isSelectedSession(session)) { if (!connected()) reconnectMain(); return transport(); }
    if (isSplitSession(session)) closeSplitPane();
    if (session.cwdExists === false) { relocationActionRef.current = "select"; setRelocationError(undefined); setRelocatingSession(session); return undefined; }
    const nextTransport = runtimePool().forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); chatSession().discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); activateTransport(nextTransport); return nextTransport;
  };
  const enqueueControl = (ownerTransport: NativeTransport, action: () => Promise<void>) => { const previous = controlQueues.current.get(ownerTransport) ?? Promise.resolve(); const next = previous.then(action, action); controlQueues.current.set(ownerTransport, next.catch(() => undefined)); return next; };
  const setModel = async (model: Model) => {
    const capturedTransport = transport(); const capturedSession = { ...chatSession() };
 const ownerTransport = capturedTransport; const ownerKey = activeConversationKeyRef.current; try { await enqueueControl(ownerTransport, async () => { await ownerTransport.command({ type: "set_model", provider: model.provider, modelId: model.id }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await capturedSession.refresh(); }); } catch (reason) { addNotice({ title: "Could not change model", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const setThinking = async (level: string) => {
    const capturedTransport = transport(); const capturedSession = { ...chatSession() };
 const ownerTransport = capturedTransport; const ownerKey = activeConversationKeyRef.current; try { await enqueueControl(ownerTransport, async () => { await ownerTransport.command({ type: "set_thinking_level", level }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) capturedSession.setState((current) => ({ ...current, thinkingLevel: level })); }); } catch (reason) { addNotice({ title: "Could not change thinking level", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const abortInteraction = async () => {
    const capturedTransport = transport();
 const ownerTransport = capturedTransport; if (abortPending.current.has(ownerTransport)) return; abortPending.current.add(ownerTransport); try { await ownerTransport.command({ type: "abort" }); } catch (reason) { addNotice({ title: "Could not stop piop", message: reason instanceof Error ? reason.message : String(reason) }); } finally { abortPending.current.delete(ownerTransport); } };
  const pauseInteraction = async () => { const capturedTransport = transport(); const capturedSession = { ...chatSession() };
    const ownerTransport = capturedTransport; const ownerKey = activeConversationKeyRef.current;
    if (abortPending.current.has(ownerTransport) || pauseResumePending.current.has(ownerTransport)) return;
    pauseResumePending.current.add(ownerTransport);
    capturedSession.setState((current) => ({ ...current, isPausing: true }));
    try {
      await ownerTransport.command({ type: "pause" });
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await capturedSession.refresh();
    } catch (reason) {
      addNotice({ title: "Could not pause piop", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      pauseResumePending.current.delete(ownerTransport);
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) capturedSession.setState((current) => ({ ...current, isPausing: false }));
    }
  };
  const resumeInteraction = async () => { const capturedTransport = transport();
    const ownerTransport = capturedTransport;
    if (abortPending.current.has(ownerTransport) || pauseResumePending.current.has(ownerTransport)) return;
    pauseResumePending.current.add(ownerTransport);
    try { await ownerTransport.command({ type: "resume" }); }
    catch (reason) { addNotice({ title: "Could not resume piop", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { pauseResumePending.current.delete(ownerTransport); }
  };
  const saveSettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig) => {
    if (settingsSavePending.current || debugModePending.current) throw new Error("Wait for the current settings save to finish");
    settingsSavePending.current = true; setSettingsSaving(true);
    try { await applySettings(value, nextConfig, previousConfig); } finally { settingsSavePending.current = false; setSettingsSaving(false); }
  };
  const applySettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig) => { const capturedSettings = settings(); const capturedTransport = transport();
    if (!capturedSettings) throw new Error("Settings are still loading");
    const next = value;
    const agentHostId = nextConfig ? "local" : undefined;
    // Use a separate, sessionless runtime to persist agent definitions without
    // reloading the extension inside a conversation that is still responding.
    const writeAgents = async (configuration: AgentConfig) => {
      const writer = new NativeTransport({ cwd: "~", hostId: "local" });
      try {
        await writer.connect(undefined, undefined, undefined, undefined, true);
        await writer.command({ type: "prompt", message: `/pi-define-agents-config ${encodeAgentValue(configuration)}` });
      } finally { await writer.dispose(); }
    };
    let agentsSaved = false;
    let savedChange: SettingsChange;
    try {
      if (nextConfig) { await writeAgents(nextConfig); agentsSaved = true; }
      savedChange = await capturedTransport.saveSettings(next, false, agentHostId);
    } catch (reason) {
      if (agentsSaved && previousConfig) {
        try { await writeAgents(previousConfig); }
        catch { throw new Error(`Settings could not be saved, and the agent definitions could not be restored: ${reason instanceof Error ? reason.message : String(reason)}`); }
      }
      throw reason;
    }
    setSettings(savedChange.settings);
    applyRuntimeSettings(savedChange.settings);
  };
  const setAgent = async (name: string) => {
    const capturedTransport = transport();
 try { await capturedTransport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const openProject = async (cwd: string, hostId: string) => {
    const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool(); const capturedComposerState = { ...composerState() };
 if (!canLeaveSettings()) return; const controls = { agent: definedAgents()?.active, model: capturedSession.state.model, thinking: capturedSession.state.thinkingLevel }; const request = projectOpenRequest.current; const validatedCwd = await capturedTransport.validateProjectDirectory(cwd, hostId); if (!projectOpenRef.current || request !== projectOpenRequest.current) return; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); capturedSession.discardPendingUpdates(); activateConversationKey(conversationKey); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = capturedRuntimePool.create({ cwd: validatedCwd, hostId }); projectControls.set(nextTransport, controls); transportConversationKeys.current.set(nextTransport, conversationKey); setComposerDraft(conversationKey, capturedComposerState.composerDraft); setComposerUploads(nextTransport, capturedComposerState.composerUploads); activateTransport(nextTransport); };
  const chooseChatProject = () => { projectOpenRequest.current += 1; setProjectOpen(true); };
  const openSplitPane = (session: SessionSummary) => { closeSplitPane(); setSplitPane({ key: crypto.randomUUID(), session }); };
  const openSessionDirectory = async (session: SessionSummary) => { const capturedTransport = transport();
    const actionKey = `open-directory:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
    try { await capturedTransport.openProjectDirectory(session.cwd, session.hostId); }
    catch (reason) { addNotice({ title: "Could not open project directory", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { sessionActionPending.current.delete(actionKey); }
    return;
  };
  const ownsSelectedSession = (owner: NativeTransport, session: SessionSummary) => owner === transport() && isSelectedSession(session);
  const ownsConversationUi = (owner: NativeTransport, key: string) => activeTransportRef.current === owner && activeConversationKeyRef.current === key;
  const archiveTarget = (session: SessionSummary, key: string) => {
    if (archivePending.current.has(key)) return;
    if (session.isDraft || !session.path) {
      addNotice({ title: "Conversation is not saved yet", message: "Send a message before archiving this draft." });
      return;
    }
    const ownerTransport = runtimePool().forSession(session);
    if (ownerTransport.isEphemeral()) {
      addNotice({ title: "Temporary conversation", message: "Temporary side conversations cannot be archived." });
      return;
    }
    if (!window.confirm(`Archive “${session.name}”?`)) return;
    return ownerTransport;
  };
  const archiveSession = async (session: SessionSummary) => { const capturedRuntimePool = runtimePool(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const archivedSessionKey = `${session.hostId ?? "local"}:${session.id}`;
    const ownerTransport = archiveTarget(session, archivedSessionKey);
    if (!ownerTransport) return;
    archivePending.current.add(archivedSessionKey);
    const isActiveSession = ownsSelectedSession(ownerTransport, session);
    const splitSession = isSplitSession(session);
    const terminalIds = conversationTerminalIds(archivedSessionKey);
    const removeArchivedUi = () => {
      archivedSessionKeys.current.add(archivedSessionKey);
      setSessions((current) => current.filter((item) => item.path !== session.path || (item.hostId ?? "local") !== (session.hostId ?? "local")));
      setComposerDrafts((current) => { if (!(archivedSessionKey in current)) return current; const next = { ...current }; delete next[archivedSessionKey]; return next; });
      setTerminalsBySession((current) => { const next = { ...current }; delete next[archivedSessionKey]; return next; });
      if (archivedSessionKey === terminalSessionIdRef.current) setTerminalOpen(false);
    };
    const recoverArchiveFailure = async (reason: unknown) => { if (isActiveSession && activeTransportRef.current === ownerTransport) { try { await ownerTransport.connect(); await capturedSession.refresh(); updateConnected(true); } catch { updateConnected(false); } } addNotice({ title: "Could not archive conversation", message: reason instanceof Error ? reason.message : String(reason) }); };
    const connectArchiveReplacement = async (hostId: string, conversationKey: string) => {
      if (ownerTransport.isTemporaryChat()) {
        const nextTransport = capturedRuntimePool.create({ hostId }); transportConversationKeys.current.set(nextTransport, conversationKey);
        try {
          const cwd = await nextTransport.prepareTemporaryChat(hostId);
          if (activeTransportRef.current !== ownerTransport || activeConversationKeyRef.current !== conversationKey) { transportConversationKeys.current.delete(nextTransport); void capturedRuntimePool.release(nextTransport); void capturedRuntimePool.release(ownerTransport).finally(() => transportConversationKeys.current.delete(ownerTransport)); }
          else { setActiveCwd(cwd); activateTransport(nextTransport); void capturedRuntimePool.release(ownerTransport).finally(() => transportConversationKeys.current.delete(ownerTransport)); }
        } catch (reason) {
          transportConversationKeys.current.delete(nextTransport); void capturedRuntimePool.release(nextTransport);
          addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex();
        }
      } else try { const replacement = capturedRuntimePool.create({ cwd: ownerTransport.currentCwd(), hostId }); transportConversationKeys.current.set(replacement, conversationKey); activateTransport(replacement); await capturedRuntimePool.release(ownerTransport); }
      catch (reason) { addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex(); }
    };
    const replaceArchivedConversation = async () => {
      const hostId = capturedActiveHostId; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
      transportConversationKeys.current.set(capturedTransport, conversationKey); activateConversationKey(conversationKey); capturedSession.discardPendingUpdates(); capturedSession.setMessages([]);
      capturedSession.setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isPaused: false, isPausing: false, activity: undefined, contextUsage: undefined }));
      await connectArchiveReplacement(hostId, conversationKey);
    };
    try {
      if (capturedRuntimePool.isRunning(ownerTransport)) throw new Error("Stop or pause this conversation before archiving it");
      if (splitSession) closeSplitPane();
      if (!isActiveSession) await capturedRuntimePool.remove(session);
      else { updateConnected(false); await ownerTransport.disconnect(); }
      await capturedTransport.archiveSession(session.path, session.hostId, terminalIds);
      removeArchivedUi();
      if (!isActiveSession) { await syncSessionIndex(); return; }
      if (!ownsConversationUi(ownerTransport, archivedSessionKey)) { await capturedRuntimePool.remove(session); await syncSessionIndex(); return; }
      await replaceArchivedConversation();
    } catch (reason) { await recoverArchiveFailure(reason); }
    finally { archivePending.current.delete(archivedSessionKey); }
    return;
  };
  const cloneSelectedSession = async (session: SessionSummary, selectedTransport: NativeTransport) => { const capturedRuntimePool = runtimePool(); const capturedSession = { ...chatSession() };
    const sourcePath = session.path; const previousKey = `${session.hostId ?? "local"}:${session.id}`; try { await selectedTransport.connect(); const sourceDiffs = await capturedRuntimePool.captureMemoryDiffs(selectedTransport); const cloned = await selectedTransport.command<{ cancelled?: boolean }>({ type: "clone" }); if (cloned.cancelled) return; const nextState = await selectedTransport.command<AgentState>({ type: "get_state" }); capturedRuntimePool.bind(session.hostId ?? "local", nextState.sessionId, selectedTransport); rekeyConversationUi(previousKey, `${session.hostId ?? "local"}:${nextState.sessionId}`, selectedTransport, true, true); if (!selectedTransport.isEphemeral()) { const sourceTransport = capturedRuntimePool.forSession(session); setUploadsByTransport((current) => { const next = new Map(current); next.set(sourceTransport, [...(current.get(selectedTransport) ?? [])]); return next; }); } const history = await selectedTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); const nextMessages = branchMessages(history.entries, history.leafId); if (activeTransportRef.current === selectedTransport) { capturedSession.setState(nextState); capturedSession.setMessages(nextMessages); updateConnected(true); } try { await capturedRuntimePool.copySavedDiffs(selectedTransport, sourcePath, nextState.sessionFile, new Set(nextMessages.map((entry) => entry.id)), sourceDiffs); } catch (reason) { addNotice({ title: "Conversation cloned, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); } await syncSessionIndex(); } catch (reason) { addNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
  };
  const cloneSession = async (session: SessionSummary, action: SessionAction) => {
    const actionKey = `${action}:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
    try {
      const selectedTransport = selectSession(session); if (!selectedTransport) return;
      if (action === "clone") { await cloneSelectedSession(session, selectedTransport); }
    } finally { sessionActionPending.current.delete(actionKey); }
  };
  const openSessionInWindow = async (session: SessionSummary) => { if (isMobile) { selectSession(session); return; } try { await openSessionWindow({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id, hostId: session.hostId }); } catch (reason) { addNotice({ title: "Could not open window", message: String(reason) }); } };
  const sessionAction = async (session: SessionSummary, action: SessionAction) => { const capturedRuntimePool = runtimePool();
    if (session.cwdExists === false && (action === "split" || action === "rename")) { relocationActionRef.current = action; setRelocationError(undefined); setRelocatingSession(session); return; }
    if (action === "split") { openSplitPane(session); return; }
    if (action === "new-window") return openSessionInWindow(session);
    if (action === "open-directory") return openSessionDirectory(session);
    if (action === "archive") return archiveSession(session);
    if (action === "rename") { setRenameSession({ session, transport: capturedRuntimePool.forSession(session) }); return; }
    return cloneSession(session, action);
  };
  const startTerminal = async (terminalId: string, cols: number, rows: number) => { const capturedTerminalSessionId = terminalSessionId(); const capturedTerminalLocationState = { ...terminalLocationState() }; const capturedTransport = transport();
    if (startingTerminals.current.has(terminalId)) return; startingTerminals.current.add(terminalId);
    const sessionKey = capturedTerminalSessionId;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = capturedTerminalLocationState.terminalCwd;
    if (!cwd) { startingTerminals.current.delete(terminalId); setTerminalsBySession((current) => { const session = current[sessionKey]; return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n"); return; }
    try { await capturedTransport.startTerminal(terminalId, sessionKey, cwd, cols, rows, capturedTerminalLocationState.terminalHostId); } catch (reason) { setTerminalsBySession((current) => { const session = current[sessionKey]; return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); } finally { startingTerminals.current.delete(terminalId); }
  };
  const addTerminal = () => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); if (session.tabs.length >= MAX_TERMINALS) return current; const id = `terminal-${sessionKey}-${crypto.randomUUID()}`; return { ...current, [sessionKey]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; }); };
  const selectTerminal = (terminalId: string) => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, activeId: terminalId } }; }); };
  const saveTerminalSnapshot = (sessionKey: string, terminalId: string, snapshot: string, snapshotEnd: number) => { setTerminalsBySession((current) => { const session = current[sessionKey]; if (!session?.tabs.some((terminal) => terminal.id === terminalId)) return current; return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, snapshot, snapshotEnd } : terminal) } }; }); };
  const deleteTerminal = async () => { const capturedComposerState = { ...composerState() }; const capturedTerminalSessionId = terminalSessionId(); const capturedTransport = transport();
    const terminalId = capturedComposerState.activeTerminal.id; const closingLast = capturedComposerState.sessionTerminals.tabs.length === 1; const panelTarget = capturedTerminalSessionId; const panelRevision = terminalPanelRevision.current;
    if (closingTerminals.current.has(terminalId)) return; closingTerminals.current.add(terminalId);
    try { await capturedTransport.closeTerminal(terminalId); } catch (reason) { addNotice({ title: "Could not close terminal", message: reason instanceof Error ? reason.message : String(reason) }); return; }
    finally { closingTerminals.current.delete(terminalId); }
    if (closingLast && terminalSessionIdRef.current === panelTarget && terminalPanelRevision.current === panelRevision) setTerminalOpen(false);
    const sessionKey = panelTarget;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); const removedIndex = session.tabs.findIndex((terminal) => terminal.id === terminalId); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current }; if (!tabs.length) delete next[sessionKey]; else next[sessionKey] = { activeId: session.activeId !== terminalId && tabs.some((tab) => tab.id === session.activeId) ? session.activeId : tabs[Math.min(Math.max(0, removedIndex), tabs.length - 1)].id, tabs }; return next; });
  };
  const setComposerDraft = (sessionKey: string, update: StateUpdate<string>) => setComposerDrafts((current) => { const value = typeof update === "function" ? update(current[sessionKey] ?? "") : update; if (value) return { ...current, [sessionKey]: value }; const next = { ...current }; delete next[sessionKey]; return next; });
  const draftChangeFor = (sessionKey: string, owner?: NativeTransport) => (update: StateUpdate<string>) => setComposerDraft(owner ? transportConversationKeys.current.get(owner) ?? sessionKey : sessionKey, update);
  const uploadsChangeFor = (owner: NativeTransport) => (update: StateUpdate<ComposerUpload[]>) => setComposerUploads(owner, update);
  const toggleTerminal = () => { if (!canLeaveSettings()) return; terminalPanelRevision.current += 1; setView("chat"); setTerminalOpen((open) => { if (!open) { const split = activePane() === "split" ? splitPane()?.session : undefined; setTerminalTarget(split ? { sessionKey: `${split.hostId ?? "local"}:${split.id}`, cwd: split.cwd, hostId: split.hostId ?? "local" } : { sessionKey: activeConversationKeyRef.current, cwd: selectedProjectCwd(activeCwd(), transport().isTemporaryChat()), hostId: activeHostIdRef.current }); } return !open; }); };
  const toggleDebugMode = () => {
    if (!settings() || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const next = { ...(settings())!, debugMode: !(settings())!.debugMode };
    void transport().saveSettings(next, false).then(() => { applyRuntimeSettings(next); setSettings(next); }).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  };
  const reconnectMain = () => {
    const ownerTransport = transport(); const ownerKey = activeConversationKeyRef.current;
    if (reconnectPending.current.has(ownerTransport)) return; reconnectPending.current.add(ownerTransport); setError(undefined); updateConnected(false);
    void ownerTransport.connect().then(() => ownerTransport.loadSettings()).then((value) => activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey ? configureRuntime(value) : undefined).then(async () => {
    const capturedSession = { ...chatSession() };
 if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await capturedSession.refresh(); }).then(() => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) { setError(undefined); updateConnected(true); void syncSessionIndex(); } }).catch((reason) => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { reconnectPending.current.delete(ownerTransport); });
  };
  createDependencyEffect(() => { const capturedSettings = settings(); const capturedActivePane = activePane(); const capturedSplitPane = splitPane();
    if (!capturedSettings) return;
    const ignoreAppShortcut = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector("dialog[open]")) return true;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (target?.closest(".keybind-input")) return true;
      return target?.closest("input, textarea, select, [contenteditable='true'], .keybind-input") && !event.ctrlKey && !event.metaKey;
    };
    const isConversationSearchShortcut = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g";
    const handleKeybind = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ignoreAppShortcut(event)) return;
      if (isConversationSearchShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (!canLeaveSettings()) return;
        setView("chat"); setPanelOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')?.focus(), 0);
        return;
      }
      const binding = keybindDefinitions.find((item) => matchesShortcut(event, (capturedSettings)!.keybindings[item.action]));
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      const actions: Record<string, () => void> = { newConversation: () => { void newSession(); }, toggleConversations: () => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen((open) => !open); }, toggleTerminal, toggleDebugMode, openSettings: () => setView("settings") };
      if (Object.hasOwn(actions, binding.action)) { actions[binding.action](); return; }
      if (!canLeaveSettings()) return; setView("chat"); window.setTimeout(() => { if (capturedActivePane === "split" && capturedSplitPane) setSplitComposerFocusRequest((value) => value + 1); else setMainComposerFocusRequest((value) => value + 1); }, 0);
    };
    window.addEventListener("keydown", handleKeybind, true);
    return () => window.removeEventListener("keydown", handleKeybind, true);
  }, () => [settings(), toggleDebugMode, settingsDirty(), view(), activePane(), splitPane()]);
  createDependencyEffect(() => { const capturedView = view(); const capturedTerminalOpen = terminalOpen();
    if (!isMobile) return;
    const back = () => { if (capturedView === "settings") { if (canLeaveSettings()) setView("chat"); } else if (capturedTerminalOpen) setTerminalOpen(false); else setPanelOpen((value) => !value); };
    window.addEventListener("piop-mobile-back", back);
    return () => window.removeEventListener("piop-mobile-back", back);
  });
  const extensionStateIsCurrent = createMemo(() => (extensionOwner() === transport()));
  const activeDialog = createMemo(() => dialogs().find((item) => !isAskUserRequest(item.request)));
  const questionContext = { requests: dialogs, respond: async (item: OwnedExtensionDialog, response: Record<string, unknown>) => {
    await item.transport.command({ type: "extension_ui_response", id: item.request.id, ...response });
    setDialogs((current) => current.filter((dialog) => dialog !== item));
  } };
  const projectCwd = createMemo(() => (selectedProjectCwd(activeCwd(), transport().isTemporaryChat() || isOrchestrator())));
  const renderMobileSidebarBackdrop = () => (panelOpen() && view() === "chat" && <button class="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);
  const renderSidebar = () => {
    const renderNavigation = () => (<nav><IconButton label="Orchestrator" class={view() === "chat" && isOrchestrator() ? "active" : ""} disabled={openingOrchestrator()} onClick={() => void showOrchestrator()}><Mic size={18} /></IconButton><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="New session group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><IconButton label={(settings())!.debugMode ? "Disable debug mode" : "Enable debug mode"} class={(settings())!.debugMode ? "active" : ""} disabled={debugModeSaving() || settingsSaving()} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label={view() === "settings" ? "Go back" : "Settings"} class={view() === "settings" ? "active" : ""} onClick={() => { if (view() !== "settings") { setView("settings"); return; } if (canLeaveSettings()) setView("chat"); }}>{view() === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { if (canLeaveSettings()) window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}</nav>);
    const renderSessionPanel = () => (view() === "chat" && panelOpen() && <SessionPanel sessions={[...sessions().filter((session) => session.id !== ORCHESTRATOR_SESSION_ID), ...liveSessions().filter((live) => live.id !== ORCHESTRATOR_SESSION_ID && !archivedSessionKeys.current.has(`${live.hostId ?? "local"}:${live.id}`) && !sessions().some((saved) => saved.id === live.id && saved.hostId === live.hostId))]} activeId={chatSession().state.sessionId} activeHostId={activeHostId()} runningSessions={runningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => void startNewSession(false, group)} onCreateWorktree={(cwd, hostId) => setWorktreeTarget({ cwd, hostId, transport: transport() })} onDeleteWorktree={deleteWorktree} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} />);
    const renderUsageBadges = () => (<div class="rail-bottom">{opencodeGoBadge() && <LimitBadge clock={usageClock()} label="OpenCode Go" prefix="Go " go detail={(opencodeGoBadge())!.detail} remainingPercent={(opencodeGoBadge())!.window.remainingPercent} resetAt={(opencodeGoBadge())!.window.resetAt} />}{codexUsage() !== undefined && <LimitBadge clock={usageClock()} label="Codex" remainingPercent={(codexUsage())!.remainingPercent} resetAt={(codexUsage())!.resetAt} />}</div>);
    return (<ResizableSidebar compact={view() === "settings" || !panelOpen()}><div class="rail-branch" title={`piop development branch: ${__PIOP_DEVELOPMENT_BRANCH__}`}><GitBranch size={13} /><span>{__PIOP_DEVELOPMENT_BRANCH__}</span></div>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };
  const chatAgentProps = () => { if (!extensionStateIsCurrent()) return { agents: [], activeAgent: undefined, agentLocked: false, agentSaved: false, agentUnavailable: false }; return { agents: (definedAgents()?.config.agents ?? []).filter((agent) => isOrchestrator() || agent.name !== VOICE_ORCHESTRATOR_AGENT), activeAgent: definedAgents()?.active, agentLocked: isOrchestrator() || definedAgents()?.locked, agentSaved: definedAgents()?.saved, agentUnavailable: definedAgents()?.unavailable }; };
  const chatModels = createMemo(() => chatSession().models.filter(model => !settings()?.hiddenModels.includes(`${model.provider}/${model.id}`)));
  const chatCommands = createMemo<SlashCommand[]>(() => [{ name: "branch-off", description: "Branch conversation [number back, default 0]", source: "builtin" }, { name: "worktree", description: "Create worktree [number back, default 0] [name]", source: "builtin" }, ...chatSession().commands.filter(command => !["branch-off", "worktree"].includes(command.name))]);
  const chatWidgets = createMemo(() => extensionStateIsCurrent() ? Object.values(widgets()).flat() : []);
  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={() => activeConversationKey()}>{(_key) => <ChatView voiceTransport={transport()}  state={chatSession().state} messages={chatSession().messages} gitDiffs={gitDiffs()} debug={(settings())!.debugMode} {...chatAgentProps()} models={chatModels()} commands={chatCommands()} thinkingLevels={chatSession().thinkingLevels} widgets={chatWidgets()} statuses={extensionStateIsCurrent() ? statuses() : {}} projectCwd={projectCwd()} filesCwd={activeCwd()} controlsDisabled={!connected()} selectionBtw draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} focusRequest={mainComposerFocusRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => { terminalPanelRevision.current += 1; setActivePane("main"); setTerminalTarget({ sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() }); setTerminalOpen(true); }} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onBranch={branch} onForkAndForget={isGitRepository() === false && projectCwd() ? forkAndForget : undefined} onCreateWorktree={isGitRepository() && projectCwd() ? (message) => setWorktreeTarget({ cwd: (projectCwd())!, hostId: activeHostId(), message, transport: transport() }) : undefined} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => { const owner = transport(); return enqueueControl(owner, () => owner.toggleFastMode()); }} onThinking={setThinking} />}</Rerun>);
      const renderSplitChatPane = () => (splitPane() && <Rerun on={() => splitPane()?.key}>{() => {
        const pane = splitPane()!;
        const currentPane = () => splitPane()?.key === pane.key ? splitPane() : undefined;
        const changeSession = (next: SessionSummary, owner: NativeTransport) => {
          const current = currentPane();
          if (!current) return;
          const previousKey = splitConversationKey(current);
          const nextKey = `${next.hostId ?? "local"}:${next.id}`;
          batch(() => {
            rekeyConversationUi(previousKey, nextKey, owner);
            setSplitPane(value => value?.key === pane.key ? { ...value, session: next } : value);
          });
        };
        return <SplitChatPane runtimePool={runtimePool()} uploadsFor={(owner) => uploadsByTransport().get(owner) ?? []} onUploadsChange={setComposerUploads}
          session={currentPane()?.session ?? pane.session} settings={settings()!} draft={composerState().splitComposerDraft}
          onDraftChange={(update) => { const current = currentPane(); if (current) setComposerDraft(splitConversationKey(current), update); }}
          focusRequest={splitComposerFocusRequest()} onActivate={() => { if (currentPane()) setActivePane("split"); }}
          onOpenTerminal={() => { const current = currentPane(); if (!current) return; terminalPanelRevision.current += 1; setActivePane("split"); setTerminalTarget({ sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); setTerminalOpen(true); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onReleaseTransport={releaseSplitTransport} onSessionChange={changeSession} forkFrom={pane.btw?.forkFrom} initialPrompt={pane.btw?.task} initialImages={pane.btw?.images}
          onReady={pane.btw ? () => respondToBtw(pane.btw!.requestId, { value: "opened" }) : undefined}
          onFailed={pane.btw ? () => respondToBtw(pane.btw!.requestId, { cancelled: true }) : undefined}
          onClose={() => { if (currentPane()) closeSplitPane(); }} />;
      }}</Rerun>);
      return (<div class={`chat-panes ${hasSidePane() ? "split" : ""}`}>
        {!notesOpen() && <IconButton class="open-notes-button" label="Open notes" aria-expanded={false} aria-controls="notes-pane" onClick={() => toggleNotes(true)}><Notebook size={19} /></IconButton>}
        {renderChatView()}
        {renderSplitChatPane()}
        {subagentPane() && <Rerun on={() => `${subagentPane()!.hostId}:${subagentPane()!.sessionId}`}>{(_key) => <SubagentPane target={subagentPane()!} onClose={closeSplitPane} onActivate={() => setActivePane("split")} />}</Rerun>}
      </div>);
    };
    return (<div class="chat-workspace" hidden={view() !== "chat"}>
      <FileWorkspace sessionKey={activeConversationKey()}>{renderChatPanes()}</FileWorkspace>
      {terminalOpen() && <Rerun on={terminalViewKey}>{(_key) => <TerminalView  cwd={terminalLocationState().terminalCwd} terminals={composerState().sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={composerState().activeTerminal.id} output={composerState().activeTerminal.output} outputEnd={composerState().activeTerminal.outputEnd} snapshot={composerState().activeTerminal.snapshot} snapshotEnd={composerState().activeTerminal.snapshotEnd} started={composerState().activeTerminal.started} exited={composerState().activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={(data) => { void transport().writeTerminal(composerState().activeTerminal.id, data).catch((reason) => queueTerminalOutput(composerState().activeTerminal.id, `\r\nTerminal input failed: ${String(reason)}\r\n`)); }} onResize={(cols, rows) => { void transport().resizeTerminal(composerState().activeTerminal.id, cols, rows).catch(() => undefined); }} onSnapshot={((sessionId: string, terminalId: string) => (value: string, outputEnd: number) => saveTerminalSnapshot(sessionId, terminalId, value, outputEnd))(terminalSessionId(), composerState().activeTerminal.id)} onDelete={deleteTerminal} onClose={() => { terminalPanelRevision.current += 1; setTerminalOpen(false); }} />}</Rerun>}
    </div>);
  };
  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={(settings())!} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} />);
  const renderToastStack = () => ((error() || notices().length > 0) && <div class="toast-stack">
      {error() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(error())!}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport())}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
      {<Key each={notices()} by={(notice) => notice.id}>{(notice, index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
    </div>);
  const renderExtensionDialog = () => (activeDialog() && !projectOpen() && !renameSession() && !relocatingSession() && !worktreeTarget() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={activeDialog()!.request} owner={activeDialog()!.owner} onRespond={async (response) => {
    const capturedActiveDialog = activeDialog()!;
 await capturedActiveDialog.transport.command({ type: "extension_ui_response", id: capturedActiveDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== capturedActiveDialog)); }} />}</Rerun>);
  const renderProjectDialog = () => (projectOpen() && <ProjectDialog initialPath={projectCwd() ?? ""} hosts={(settings())!.hosts} initialHostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const renderRelocationDialog = () => (relocatingSession() && <Rerun on={() => relocatingSession()?.id}>{(_key) => <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${(relocatingSession())!.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${(relocatingSession())!.cwd}. Enter its new location to open this conversation.`, error: relocationError(), placeholder: "Replacement project directory", prefill: sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId() && session.cwdExists !== false)?.cwd || "" }} onRespond={async (response) => {
    const session = relocatingSession()!; const ownerTransport = transport(); const pool = runtimePool(); const action = relocationActionRef.current;
    if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; }
    const cwd = typeof response.value === "string" ? response.value : "";
    if (!hasVisibleText(cwd)) { setRelocationError("Path can't be empty"); return; }
    setRelocationError(undefined);
    try {
      await ownerTransport.relocateSession(session.path, cwd, session.hostId);
      const relocated = (await ownerTransport.listSessions()).find((item) => item.id === session.id && (item.hostId ?? "local") === (session.hostId ?? "local"));
      if (!relocated) throw new Error("The relocated conversation could not be found. Refresh the conversation list and retry.");
      const hostId = session.hostId ?? "local"; const projectPath = relocated.projectRoot ?? relocated.cwd;
      try { await updateSessionGroups({ type: "relocate", key: `${hostId}:${session.id}`, project: { id: `${hostId}:${projectPath}`, name: projectPath.split("/").filter(Boolean).at(-1) ?? relocated.project, cwd: projectPath, hostId, hostName: relocated.hostName, projectKind: relocated.projectKind } }); }
      catch (reason) { addNotice({ title: "Project relocated, but its sidebar group could not be updated", message: String(reason) }); }
      setSessions((current) => current.map((item) => item.id === session.id && (item.hostId ?? "local") === hostId ? relocated : item));
      const owner = pool.forSession(session);
      pool.setLiveSession(owner, relocated);
      await owner.restoreConnection({ cwd: relocated.cwd, sessionPath: session.path, hostId });
      setRelocatingSession(undefined);
      if (action === "split") openSplitPane(relocated);
      else if (action === "rename") setRenameSession({ session: relocated, transport: owner });
      else selectSession(relocated);
    } catch (reason) { setRelocationError(reason instanceof Error ? reason.message : String(reason)); }
  }} />}</Rerun>);
  const renderWorktreeDialog = () => (worktreeTarget() && <WorktreeDialog projectPath={(worktreeTarget())!.cwd} fromProject={!(worktreeTarget())!.message} beforePrompt={(worktreeTarget())!.message?.role === "user"} onCancel={() => setWorktreeTarget(undefined)} onCreate={(name, onSetup) => createWorktree((worktreeTarget())!, name, onSetup)} />);
  const renderSubagentFind = () => subagentPane() && <FindInPage selector=".subagent-pane .chat-shell" scopeKey={`${subagentPane()!.hostId}:${subagentPane()!.sessionId}`} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />;
  return <SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div class={`app dark ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    <div class="mobile-navigation"><button aria-label="Toggle conversations" aria-expanded={panelOpen() && view() === "chat"} onClick={() => { if (canLeaveSettings()) { setView("chat"); setPanelOpen((value) => !value); } }}>☰</button></div>
    {renderMobileSidebarBackdrop()}
    {import.meta.env.MODE === "e2e" && <div class="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /></div>}
    {renderSidebar()}
    <ConversationQuestionsContext.Provider value={questionContext}>{renderChatWorkspace()}</ConversationQuestionsContext.Provider>
    {renderSettingsView()}
    <NotesPane hidden={view() !== "chat"} open={notesOpen()} onClose={() => toggleNotes(false)} />
    <FindInPage selector=".chat-panes > .chat-shell" scopeKey={activeConversationKey()} onActivate={() => setActivePane("main")} active={activePane() === "main" || !hasSidePane()} enabled={view() === "chat"} />
    {renderSubagentFind()}
    {splitPane() && <Rerun on={() => splitSessionId()}>{(_key) => <FindInPage selector=".split-chat .chat-shell" scopeKey={splitSessionId()} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />}</Rerun>}
    {view() === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    {renderToastStack()}
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: (renameSession())!.session.name }} onRespond={async (response) => {
    const capturedRenameSession = renameSession(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId();
 if (response.cancelled) { setRenameSession(undefined); return; } if (typeof response.value !== "string" || !hasVisibleText(response.value)) throw new Error("Conversation name can't be empty"); const name = response.value.trim(); await (capturedRenameSession)!.transport.connect(); await (capturedRenameSession)!.transport.command({ type: "set_session_name", name }); if ((capturedRenameSession)!.session.id === capturedSession.state.sessionId && ((capturedRenameSession)!.session.hostId ?? "local") === capturedActiveHostId) capturedSession.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}</Rerun>}
    {renderRelocationDialog()}
    {renderWorktreeDialog()}
  </div>)}</SubagentNavigationContext.Provider>;
}
