import { ConversationChangedError, isConversationChanged } from "./lib/conversationChanged"; import { chatSubmission, prepareChatWorktree } from "./lib/newChatWorktree"; import { useAppKeyboard } from "./useAppKeyboard";
import { createConversationViewKey, createTransportActivation, useWorkspaceDisconnect } from "./appTransportActivation"; import { seedChatSelection } from "./lib/newChatSelection"; import { resolveNewSessionBranch } from "./lib/newSessionBranch";
import { createTerminalController } from "./appTerminals";
import { createConversationDrafts } from "./appDrafts";
import { createConversationArchive } from "./appArchive";
import { createSidebarState } from "./lib/sidebarState";
import { createWorktreeActions } from "./appWorktrees";
import { configureConversationRuntime, createComposerControls, inheritGroupControls, newChatAgent, openDraftSession, type ProjectControls } from "./appRuntime";
import { Key, Rerun } from "@solid-primitives/keyed";
import { ArrowLeft, Bug, FolderPlus, GitBranch, MessageSquare, Server, Settings } from "lucide-solid";
import { batch, createComputed, createMemo, createSignal, lazy, Show } from "solid-js";
import { AppLoading, dialogOwnerName, goUsageBadge, LimitBadge, normalizeCodexUsage, normalizeOpencodeGoUsage, selectedProjectCwd, splitConversationKey, useUsageClock, type OwnedExtensionDialog, type RenameTarget, type SplitPaneState, type TerminalTarget, type WorktreeTarget } from "./appSupport";
import { createBranchConversation } from "./branchConversation";
import { ConversationQuestionsContext, createConversationQuestions } from "./components/ConversationQuestions";
import { isAskUserRequest } from "./components/AskUserDialog";
import { FindInPage } from "./components/FindInPage";
import { IconButton } from "./components/IconButton";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { SessionPanel, type SessionAction } from "./components/SessionPanel";
import { SubagentNavigationContext, type SubagentTarget } from "./lib/subagentNavigation";
import { encodeAgentValue } from "./lib/agentProtocol";
import { saveClientSettings, withClientSettings } from "./lib/clientSettings";
import { hasVisibleText } from "./lib/content";
import { branchMessages, type PiEntry } from "./lib/messages";
import { recordSeenModels } from "./lib/modelVisibility";
import { initialWindowTarget, NativeTransport, openSessionWindow, resolveBranchGroup } from "./lib/nativeTransport";
import { sessionDebugAction } from "./lib/sessionDebugAction";
import { useSessionResume } from "./lib/sessionResume";
import { createCachedSessionList } from "./lib/sessionListCache";
import { isMobile, listen } from "./lib/platform";
import { DIRLESS_KEY, inheritSessionGroup, updateSessionGroups, type SessionGroup } from "./lib/sessionGroups";
import { SessionRuntimePool, useTurnDiffs } from "./lib/sessionRuntimePool";
import { createDependencyEffect, createMemoFields, createRef, createSubscription, type StateUpdate } from "./lib/solid";
import { useChatSession } from "./lib/useChatSession";
import type { AgentConfig, AgentState, AppSettings, ChatMessage, CodexUsage, ComposerUpload, DefinedAgentsCapability, ExtensionUiRequest, ImageAttachment, Model, OpencodeGoUsage, SessionSummary, SettingsChange, SlashCommand } from "./types";
import { useAppEvents } from "./useAppEvents";
export { formatCodexReset,normalizeCodexUsage,normalizeOpencodeGoUsage,usageWindowsDescription } from "./appSupport";
declare const __PIOP_DEVELOPMENT_BRANCH__: string;
const LocalSettingsView = lazy(() => import("./components/LocalSettingsView").then(module => ({ default: module.LocalSettingsView })));
const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));
const ChatView = lazy(() => import("./components/ChatView").then(module => ({ default: module.ChatView })));
const ExtensionDialog = lazy(() => import("./components/ExtensionDialog").then(module => ({ default: module.ExtensionDialog })));
const ProjectDialog = lazy(() => import("./components/ProjectDialog").then(module => ({ default: module.ProjectDialog })));
const SplitChatPane = lazy(() => import("./components/SplitChatPane").then(module => ({ default: module.SplitChatPane })));
const SubagentPane = lazy(() => import("./components/SubagentPane").then(module => ({ default: module.SubagentPane })));
const WorktreeDialog = lazy(() => import("./components/WorktreeDialog").then(module => ({ default: module.WorktreeDialog })));
export default function App() {
  const runtimePool = createMemo(() => new SessionRuntimePool()); const [transport, setTransport] = createSignal((() => { const initial = runtimePool().create(initialWindowTarget()); runtimePool().activate(initial); return initial; })()); const [view, setView] = createSignal<"chat" | "settings">("chat");
  const activeTransportRef = createRef(transport()); createComputed(() => { activeTransportRef.current = transport(); });
  const pendingSessionGroups = createRef(new WeakMap<NativeTransport, SessionGroup>());
  const initialConversationKey = createRef(`local:draft-${crypto.randomUUID()}`);
  const [activeConversationKey, setActiveConversationKey] = createSignal(initialConversationKey.current); const chatViewKey = createConversationViewKey(transport, activeConversationKey, () => chatSubmission(transport())?.message);
  const activeConversationKeyRef = createRef(activeConversationKey()); createComputed(() => { activeConversationKeyRef.current = activeConversationKey(); });
  const transportConversationKeys = createRef(new Map<NativeTransport, string>([[transport(), initialConversationKey.current]]));
  const liveSessionRevision = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().liveSessionRevision());
  const liveSessions = createMemo(() => { liveSessionRevision(); return runtimePool().liveSessionSummaries(); });
  const runningSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().runningSessions());
  const unseenSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().unseenSessions());
  const pendingSettingsCount = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().pendingSettingsCount());
  const gitDiffs = useTurnDiffs(() => (runtimePool()), () => (transport()));
  const sessionRuntime = useChatSession(() => (transport())); const chatSession = createMemo(() => (sessionRuntime));
  const [sessions, setSessions] = createCachedSessionList(); const [settings, setSettings] = createSignal<AppSettings>();
  const runtimeSettings = createRef<AppSettings | undefined>(undefined);
  const applyRuntimeSettings = (next: AppSettings) => {
    const previous = runtimeSettings.current;
    runtimeSettings.current = next;
    if (previous) runtimePool().queueSettingsChange(previous, next);
  };
  const [definedAgents, setDefinedAgents] = createSignal<DefinedAgentsCapability>();
  const settingsSavePending = createRef(false); const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [debugModeSaving, setDebugModeSaving] = createSignal(false);
  const debugModePending = createRef(false);
  const [settingsDirty, setSettingsDirty] = createSignal(false);
  const settingsDirtyRef = createRef(settingsDirty()); createComputed(() => { settingsDirtyRef.current = settingsDirty(); });
  const sessionIndexRequest = createRef<Promise<void> | undefined>(undefined);
  const sessionIndexDirty = createRef(false);
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
    if (activeTransportRef.current === ownerTransport || capturedRuntimePool.isInteractive(ownerTransport)) return;
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
  const drafts = createConversationDrafts();
  const { composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, transportHasDraft } = drafts;
  const newSessionPending = createRef(false);
  const lastNewSessionSelection = createRef<string | undefined>(undefined);
  const abortPending = createRef(new Set<NativeTransport>());
  const pauseResumePending = createRef(new Set<NativeTransport>());
  const branchPending = createRef(new Set<string>());
  const sessionActionPending = createRef(new Set<string>());
  const [splitPane, setSplitPane] = createSignal<SplitPaneState>();
  const [subagentPane, setSubagentPane] = createSignal<SubagentTarget>();
  const hasSidePane = () => Boolean(splitPane() || subagentPane());
  createDependencyEffect(() => { if (splitPane()) setSubagentPane(undefined); }, () => [splitPane()]);
  const [mainComposerFocusRequest, setMainComposerFocusRequest] = createSignal(0);
  const [splitComposerFocusRequest, setSplitComposerFocusRequest] = createSignal(0);
  const [activePane, setActivePane] = createSignal<"main" | "split">("main");
  const pendingBtwRequest = createRef<{ id: string; transport: NativeTransport } | undefined>(undefined);
  const terminals = createTerminalController({
    transport, conversationKey: activeConversationKey, addNotice,
    location: () => ({ cwd: activeCwd() ?? sessions().find(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.cwd, hostId: activeHostId() }),
  });
  const { terminalOpen, setTerminalOpen, setTerminalTarget, terminalSessionId, terminalLocationState, conversationTerminalIds, queueTerminalOutput, startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal } = terminals;
  const reconnectPending = createRef(new Set<NativeTransport>());
  useSessionResume(() => ({ ready: connected(), saved: chatSession().state.messageCount > 0, ephemeral: transport().isEphemeral(), target: { sessionId: chatSession().state.sessionId, sessionPath: chatSession().state.sessionFile, cwd: activeCwd(), hostId: activeHostId() } }));
  const splitSessionId = createMemo(() => splitConversationKey(splitPane()));
  const composerValues = () => {
    const composerDraft = composerDrafts()[activeConversationKey()] ?? "";
    const composerUploads = uploadsByTransport().get(transport()) ?? [];
    const splitComposerDraft = composerDrafts()[splitSessionId()] ?? "";
    return { composerDraft, composerUploads, splitComposerDraft };
  };
  const composerFields = createMemoFields(composerValues);
  const composerState = () => composerFields;
  const terminalViewKey = terminals.viewKey;
  const activateConversationKey = (key: string) => { activeConversationKeyRef.current = key; setActiveConversationKey(key); };
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool();
 capturedRuntimePool.setErrorHandler((message) => addNotice({ title: message.startsWith("Could not load saved project changes") || message.startsWith("Could not save project changes") ? "Project changes" : "Session", message })); return () => { capturedRuntimePool.setErrorHandler(); }; }, () => [addNotice, runtimePool()]);
  createDependencyEffect(() => {
    const capturedTransport = transport();
 let cancelled = false; const load = () => { void capturedTransport.loadCodexUsage().then((usage) => { if (!cancelled) setCodexUsage(normalizeCodexUsage(usage)); }).catch(() => undefined); void capturedTransport.loadOpencodeGoUsage().then((usage) => { if (!cancelled) setOpencodeGoUsage(normalizeOpencodeGoUsage(usage)); }).catch(() => undefined); }; load(); const interval = window.setInterval(load, 60_000); window.addEventListener("focus", load); return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener("focus", load); }; }, () => [transport()]);
  createDependencyEffect(() => { const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const previousKey = activeConversationKeyRef.current;
    if (!capturedSession.state.sessionId || !previousKey.includes(":draft-")) return;
    const canonicalKey = `${capturedActiveHostId}:${capturedSession.state.sessionId}`; if (previousKey === canonicalKey) return;
    rekeyConversationUi(previousKey, canonicalKey, capturedTransport);
  }, () => [activeHostId(), chatSession().state.sessionId, transport()]);
  createDependencyEffect(() => { const capturedTransport = transport();
    let cancelled = false;
    setIsGitRepository(undefined);
    void capturedTransport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, () => [transport(), sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.projectKind]);
  useUsageClock(() => (codexUsage()), () => (opencodeGoUsage()), () => (setUsageClock));
  createDependencyEffect(() => { const capturedSettings = settings(); const capturedSession = { ...chatSession() };
    if (!capturedSettings || capturedSession.models.length === 0 || settingsSavePending.current) return;
    const next = recordSeenModels((capturedSettings)!, capturedSession.models.map((model) => `${model.provider}/${model.id}`));
    if (!next) return;
    void saveClientSettings(next).then(() => setSettings(current => current ? { ...current, knownModels: next.knownModels, hiddenModels: next.hiddenModels } : current)).catch(() => undefined);
  }, () => [chatSession().models, settings(), transport()]);
  const syncSessionIndex = () => {
    if (sessionIndexRequest.current) { sessionIndexDirty.current = true; return sessionIndexRequest.current; }
    sessionIndexDirty.current = false;
    if (!sessionIndexRequest.current) sessionIndexRequest.current = transport().listSessions().then((nextSessions) => {
      setSessions(nextSessions.filter((session) => !runtimePool().isRemoved(session) && !archives.isArchived(session)));
      chatSession().setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId && (session.hostId ?? "local") === activeHostIdRef.current);
        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch(() => undefined).finally(() => { sessionIndexRequest.current = undefined; if (sessionIndexDirty.current) void syncSessionIndex(); });
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
    let revision = 0; let pendingSettings: AppSettings | undefined;
    const update = (value: AppSettings) => {
      pendingSettings = value; const current = ++revision;
      void withClientSettings(value).then(next => {
        if (current !== revision) return;
        pendingSettings = undefined; applyRuntimeSettings(next); setSettings(next);
      }).catch(reason => addNotice({ title: "Could not load client preferences", message: String(reason) }));
    };
    const pending = listen<SettingsChange>("pi://settings-changed", ({ payload }) => {
      update(payload.settings);
    });
    const clientPending = listen("pi://client-settings-changed", () => { const current = pendingSettings ?? settings(); if (current) update(current); });
    return () => { revision++; void pending.then((unlisten) => unlisten()); void clientPending.then((unlisten) => unlisten()); };
  }, () => [applyRuntimeSettings]);
  const loadSettings = async () => { const owner = transport(); const request = owner.loadSettings(); void ChatView.preload().catch(() => undefined); const nextSettings = await request;
    if (activeTransportRef.current !== owner) throw new ConversationChangedError();
    applyRuntimeSettings(nextSettings); setSettings(nextSettings); return nextSettings; };
  const refresh = async (hostId?: string, loadedSettings?: AppSettings) => { const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool();
    void syncSessionIndex();
    const settingsRequest = loadedSettings ? Promise.resolve(settings() ?? loadedSettings) : loadSettings();
    const [nextState, nextSettings] = await Promise.all([capturedSession.refresh(), settingsRequest]); capturedRuntimePool.bind(hostId ?? capturedTransport.currentHostId(), nextState.sessionId, capturedTransport);
    const group = pendingSessionGroups.current.get(capturedTransport);
    if (group && nextState.sessionId && nextState.messageCount > 0) {
      try {
        const key = `${hostId ?? capturedTransport.currentHostId()}:${nextState.sessionId}`; await updateSessionGroups(group.cwd ? { type: "project", key, project: group } : { type: "assign", key, group: group.id });
        pendingSessionGroups.current.delete(capturedTransport);
      } catch (reason) { addNotice({ title: "Could not add chat to group", message: String(reason) }); }
    }
    return nextSettings;
  };
  const projectControls = new WeakMap<NativeTransport, ProjectControls>(); const composerControls = createComposerControls(transport, connected, projectControls, () => definedAgents()?.config.fastModeModels);
  const configureRuntime = (value: AppSettings) => configureConversationRuntime(value, transport(), () => activeTransportRef.current, projectControls);
  const btwImages = new WeakMap<NativeTransport, ImageAttachment[]>();
  const resolveHomeDirectory = (hostId: string) => transport().homeDirectory(hostId);
  useAppEvents(() => ({ transport: transport(), handleEvent: chatSession().handleEvent, setDialogs, loadSettings, refresh, queueTerminalOutput, terminalExited: terminals.exited, addNotice, activeTransportRef, pendingBtwRequest, btwImages, setSplitPane, activeHostIdRef, setExtensionOwner, setDefinedAgents, refreshSession: chatSession().refresh, setStatuses, setWidgets, setComposerDraft, transportConversationKeys, terminalSessionId, setActivePane, setMainComposerFocusRequest, queueExtensionDialog, mainDialogOwnerRef, setActiveHostId, setActiveCwd, activateConversationKey, setTerminalOpen, setTerminalTarget, configureRuntime, setError, updateConnected, flushTerminalOutput: terminals.flushOutput }));
  createDependencyEffect(() => {
    const capturedTransport = transport(); const capturedRuntimePool = runtimePool();
 const shutdown = () => { for (const id of terminals.allTerminalIds()) void capturedTransport.closeTerminal(id).catch(() => undefined); void capturedRuntimePool.disconnectAll(); }; window.addEventListener("pagehide", shutdown); return () => window.removeEventListener("pagehide", shutdown); }, () => [runtimePool(), transport()]);
  createDependencyEffect(() => {
    const capturedSettingsDirty = settingsDirty();
 if (!capturedSettingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, () => [settingsDirty()]);
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool(); const capturedView = view(); const capturedTransport = transport();
 capturedRuntimePool.activate(capturedView === "chat" ? capturedTransport : undefined); }, () => [runtimePool(), transport(), view()]);
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
  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => { const capturedTransport = await prepareChatWorktree(transport(), async (cwd, host, onActivate) => { const group = pendingSessionGroups.current.get(transport()); await openProject(cwd, host, true, onActivate); if (group) pendingSessionGroups.current.set(transport(), group); }, transport, connected, error);
    if (!connectionReadyRef.current) throw new Error("piop is still connecting");
    const ownerTransport = capturedTransport;
    const imagePayload = images.length ? { images } : {};
    if (/^\/btw(?:\s|$)/.test(text.trim())) btwImages.set(capturedTransport, images);
    const branchCommand = /^\/(worktree|branch-off)(?:\s+(.*))?$/s.exec(text.trim());
    if (branchCommand) {
      return sendBranchCommand(branchCommand, images);
    }
    try {
    if (behavior) { await ownerTransport.submitPrompt({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...imagePayload }); return; }
    await capturedTransport.submitPrompt({ type: "prompt", message: text, ...imagePayload });
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
  const activateTransport = createTransportActivation({ savedSessions: sessions, transport, transportConversationKeys, transportHasDraft, conversationTerminalIds, runtimePool, chatSession, composerDrafts, activeTransportRef, setTransport, discardDraft: drafts.discard, forgetTerminals: terminals.forgetConversation });
  useWorkspaceDisconnect(() => settingsDirty() || Object.values(composerDrafts()).some(Boolean) || [...uploadsByTransport().values()].some(items => items.length > 0), runtimePool, terminals.allTerminalIds, () => activeTransportRef.current);
  const rekeyConversationUi = (previousKey: string, nextKey: string, ownerTransport: NativeTransport, moveTerminals = true, copyDraft = false) => {
    if (previousKey === nextKey) return;
    drafts.rekeyDraft(previousKey, nextKey, copyDraft);
    if (moveTerminals) terminals.rekeyConversation(previousKey, nextKey, ownerTransport);
    transportConversationKeys.current.set(ownerTransport, nextKey);
    if (ownerTransport === activeTransportRef.current) activateConversationKey(nextKey);
  };
  const branchConversation = createMemo(() => (createBranchConversation({ transport: transport(), activeConversationKeyRef, branchPending, state: chatSession().state, sessions: sessions(), runtimePool: runtimePool(), messages: chatSession().messages, rekeyConversationUi, activeTransportRef, setActiveCwd, setTerminalOpen, setTerminalTarget, setState: chatSession().setState, setMessages: chatSession().setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, addNotice, syncSessionIndex })));
  const { createWorktree, deleteWorktree } = createWorktreeActions({ settings, runtimePool, transport, addNotice, setWorktreeTarget, setSessions, setComposerDraft: (...args) => setComposerDraft(...args), setComposerUploads, selectSession: (session) => selectSession(session), syncSessionIndex });
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
  const canStartNewSession = () => !newSessionPending.current && canLeaveSettings();
  const newSessionTarget = (clearProject: boolean, group?: SessionGroup) => ({ hostId: group ? group.hostId ?? "local" : activeHostIdRef.current, projectCwd: group ? group.cwd ?? undefined : clearProject ? undefined : selectedProjectCwd(activeCwd(), transport().isTemporaryChat()) });
  const createSessionTransport = (cwd: string | undefined, hostId: string) => { const owner = runtimePool().create(cwd ? { cwd, hostId } : { hostId }); seedChatSelection(owner, cwd, hostId, [...sessions(), ...liveSessions()]); return owner; };
  const prepareNewSession = (owner: NativeTransport, hostId: string, cwd?: string) => cwd ? owner.validateProjectDirectory(cwd, hostId, true) : owner.prepareTemporaryChat(hostId);
  const assignNewSessionGroup = (owner: NativeTransport, group?: SessionGroup) => { if (group) pendingSessionGroups.current.set(owner, group); };
  const discardNewSessionDraft = (owner: NativeTransport, key: string) => {
    setComposerDraft(key, ""); setComposerUploads(owner, []); pendingSessionGroups.current.delete(owner);
    void Promise.all(conversationTerminalIds(key).map(id => owner.closeTerminal(id))).then(async () => {
      terminals.resetConversation(key);
      await runtimePool().release(owner); transportConversationKeys.current.delete(owner);
    }).catch(reason => addNotice({ title: "Could not clean up the draft", message: String(reason) }));
  };
  const copyNewSessionDraft = (key: string, owner: NativeTransport, copy: boolean) => {
    if (!copy) return;
    setComposerDraft(key, composerState().composerDraft); setComposerUploads(owner, composerState().composerUploads);
  };
  const startNewSession = async (clearProject = false, group?: SessionGroup, discardDraft = false) => {
    if (!canStartNewSession()) return;
    const ownerTransport = transport(); const ownerKey = activeConversationKeyRef.current;
    const isCurrent = () => activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey;
    const capturedSession = { ...chatSession() }; const pool = runtimePool();
    const target = newSessionTarget(clearProject, group);
    const { hostId } = target;
    let projectCwd = target.projectCwd;
    const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
    let nextTransport: NativeTransport | undefined;
    let activated = false;
    const releaseUnusedTransport = () => {
      if (activated || !nextTransport) return;
      transportConversationKeys.current.delete(nextTransport); pendingSessionGroups.current.delete(nextTransport);
      void pool.release(nextTransport).catch((reason) => addNotice({ title: "Could not clean up the new conversation", message: String(reason) }));
    };
    newSessionPending.current = true;
    try {
      projectCwd = await resolveNewSessionBranch(projectCwd, hostId, Boolean(group), isCurrent);
      const owner = createSessionTransport(projectCwd, hostId);
      nextTransport = owner;
      inheritGroupControls(projectControls, owner, true, composerControls.state(capturedSession.state), definedAgents(), composerControls.statuses(statuses()), settings());
      const cwd = await prepareNewSession(owner, hostId, projectCwd);
      if (!isCurrent()) return;
      transportConversationKeys.current.set(nextTransport, conversationKey);
      assignNewSessionGroup(nextTransport, group);
      batch(() => {
        copyNewSessionDraft(conversationKey, owner, (clearProject || Boolean(group && capturedSession.state.messageCount === 0)) && !discardDraft);
        setView("chat"); closeSplitPane(); setTerminalOpen(false); setTerminalTarget(undefined);
        updateConnected(false); setDefinedAgents(undefined); capturedSession.discardPendingUpdates();
        setActiveCwd(cwd); setActiveHostId(hostId); activateTransport(owner); activateConversationKey(conversationKey);
      });
      activated = true;
      if (discardDraft) discardNewSessionDraft(ownerTransport, ownerKey);
    } catch (reason) {
      if (isCurrent()) {
        addNotice({ title: "Could not start a new conversation", message: reason instanceof Error ? reason.message : String(reason) });
      }
    } finally {
      newSessionPending.current = false;
      releaseUnusedTransport();
    }
  };
  const currentSessionHasSavedMessages = () => sessions().some(session => session.messageCount > 0 && (session.hostId ?? "local") === activeHostId() && session.path === transport().currentSessionPath());
  const newSession = async () => {
    if (!canStartNewSession()) return;
    const empty = !currentSessionHasSavedMessages() && !chatSession().state.isStreaming && chatSession().state.messageCount === 0 && chatSession().messages.length === 0;
    const repeat = view() === "chat" && empty && lastNewSessionSelection.current === activeConversationKey();
    if (repeat) await startNewSession(true, undefined, true);
    else if (empty) await openDraftSession(transport(), { cwd: transport().currentCwd(), hostId: activeHostId() }, transport, () => { setView("chat"); closeSplitPane(); }, reason => addNotice({ title: "Project unavailable", message: String(reason) }));
    else {
      const draft = liveSessions().filter(session => session.isDraft && !sessions().some(saved => saved.messageCount > 0 && (saved.hostId ?? "local") === (session.hostId ?? "local") && (saved.id === session.id || Boolean(session.path && saved.path === session.path)))).sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
      if (draft) await openDraftSession(transport(), draft, transport, () => { selectSession(draft); }, reason => addNotice({ title: "Project unavailable", message: String(reason) }));
      else await startNewSession();
    }
    lastNewSessionSelection.current = activeConversationKey(); setMainComposerFocusRequest(request => request + 1);
  };
  const clearChatProject = () => startNewSession(true);
  const isSplitSession = (session: SessionSummary) => splitPane()?.session.id === session.id && ((splitPane())!.session.hostId ?? "local") === (session.hostId ?? "local");
  const isSelectedSession = (session: SessionSummary) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId();
  const selectSession = (session: SessionSummary) => {
    if (!canLeaveSettings()) return undefined;
    lastNewSessionSelection.current = undefined;
    if (window.matchMedia("(max-width: 700px)").matches) setPanelOpen(false);
    if (archives.isPending(session)) return undefined;
    const hostId = session.hostId ?? "local"; if (isSelectedSession(session)) { if (!connected()) reconnectMain(); return transport(); }
    if (isSplitSession(session)) closeSplitPane();
    if (session.cwdExists === false) { void openDirlessSession(session, "select"); return undefined; }
    const nextTransport = runtimePool().forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); chatSession().discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); activateTransport(nextTransport); return nextTransport;
  };
  const setModel = (model: Model) => transport().promptControls.model(model, composerControls.state(chatSession().state).thinkingLevel);
  const setThinking = (level: string) => transport().promptControls.thinking(level);
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
    const next = value; const agentHostId = nextConfig ? "local" : undefined;
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
 try { await capturedTransport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }); capturedTransport.promptControls.reset(); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const openProject = async (cwd: string, hostId: string, fromBranch = false, onActivate?: (destination: NativeTransport) => void) => {
    const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool(); const capturedComposerState = { ...composerState() };
 if (!canLeaveSettings()) return; const controls = { agent: newChatAgent(definedAgents(), settings()?.defaultAgent), model: composerControls.state(capturedSession.state).model, thinking: composerControls.state(capturedSession.state).thinkingLevel, fastMode: composerControls.statuses(statuses())["pi-desktop-fast-mode"] === "Fast mode on", contextWindow: capturedSession.state.contextUsage?.contextWindow }; const request = projectOpenRequest.current; const validatedCwd = await capturedTransport.validateProjectDirectory(cwd, hostId, fromBranch); if (capturedTransport !== activeTransportRef.current || (!fromBranch && (!projectOpenRef.current || request !== projectOpenRequest.current))) return; batch(() => { const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); capturedSession.discardPendingUpdates(); activateConversationKey(conversationKey); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = capturedRuntimePool.create({ cwd: validatedCwd, hostId }); projectControls.set(nextTransport, controls); transportConversationKeys.current.set(nextTransport, conversationKey); setComposerDraft(conversationKey, capturedComposerState.composerDraft); setComposerUploads(nextTransport, capturedComposerState.composerUploads); onActivate?.(nextTransport); activateTransport(nextTransport); }); };
  const chooseChatProject = () => { projectOpenRequest.current += 1; setProjectOpen(true); };
  const openSplitPane = (session: SessionSummary) => { closeSplitPane(); setSplitPane({ key: crypto.randomUUID(), session }); };
  const openSessionDirectory = async (session: SessionSummary) => { const capturedTransport = transport();
    const actionKey = `open-directory:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
    try { await capturedTransport.openProjectDirectory(session.cwd, session.hostId); }
    catch (reason) { addNotice({ title: "Could not open project directory", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { sessionActionPending.current.delete(actionKey); }
    return;
  };
  const archives = createConversationArchive({
    runtimePool, transport, chatSession, activeHostId, activeTransportRef, activeConversationKeyRef,
    transportConversationKeys, isSelectedSession, isSplitSession, conversationTerminalIds,
    removeConversationTerminals: terminals.removeConversationTerminals, removeDraft: drafts.removeDraft,
    setSessions, setActiveCwd, activateTransport, activateConversationKey, updateConnected,
    closeSplitPane, syncSessionIndex, addNotice,
  });
  const archiveSession = archives.archiveSession;
  const cloneSelectedSession = async (session: SessionSummary, selectedTransport: NativeTransport) => { const capturedRuntimePool = runtimePool(); const capturedSession = { ...chatSession() };
    const hostId = session.hostId ?? "local";
    const sourcePath = session.path; const previousKey = `${hostId}:${session.id}`; try { await selectedTransport.connect(); const sourceDiffs = await capturedRuntimePool.captureMemoryDiffs(selectedTransport); const cloned = await selectedTransport.command<{ cancelled?: boolean }>({ type: "clone" }); if (cloned.cancelled) return; const nextState = await selectedTransport.command<AgentState>({ type: "get_state" }); await inheritSessionGroup(previousKey, `${hostId}:${nextState.sessionId}`, session); capturedRuntimePool.bind(hostId, nextState.sessionId, selectedTransport); rekeyConversationUi(previousKey, `${hostId}:${nextState.sessionId}`, selectedTransport, true, true); if (!selectedTransport.isEphemeral()) { const sourceTransport = capturedRuntimePool.forSession(session); drafts.copyUploads(selectedTransport, sourceTransport); } const history = await selectedTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); const nextMessages = branchMessages(history.entries, history.leafId); if (activeTransportRef.current === selectedTransport) { capturedSession.setState(nextState); capturedSession.setMessages(nextMessages); updateConnected(true); } try { await capturedRuntimePool.copySavedDiffs(selectedTransport, sourcePath, nextState.sessionFile, new Set(nextMessages.map((entry) => entry.id)), sourceDiffs); } catch (reason) { addNotice({ title: "Conversation cloned, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); } await syncSessionIndex(); } catch (reason) { addNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
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
    if (["copy-id", "open-rollout"].includes(action)) { await sessionDebugAction(session, action, addNotice); return; }
    if (session.cwdExists === false && action !== "archive" && action !== "open-directory") { await openDirlessSession(session, action); return; }
    if (action === "split") { openSplitPane(session); return; }
    if (action === "new-window") return openSessionInWindow(session);
    if (action === "open-directory") return openSessionDirectory(session);
    if (action === "archive") return archiveSession(session);
    if (action === "rename") { setRenameSession({ session, transport: capturedRuntimePool.forSession(session) }); return; }
    return cloneSession(session, action);
  };
  const draftChangeFor = (sessionKey: string, owner?: NativeTransport) => (update: StateUpdate<string>) => setComposerDraft(owner ? transportConversationKeys.current.get(owner) ?? sessionKey : sessionKey, update);
  const uploadsChangeFor = (owner: NativeTransport) => (update: StateUpdate<ComposerUpload[]>) => setComposerUploads(owner, update);
  const toggleComposerTerminal = (pane: "main" | "split", target: TerminalTarget) => {
    setActivePane(pane); terminals.toggleFor(target);
  };
  const toggleTerminal = () => {
    if (!canLeaveSettings()) return;
    setView("chat");
    terminals.toggle(() => {
      const split = activePane() === "split" ? splitPane()?.session : undefined;
      return split ? { sessionKey: `${split.hostId ?? "local"}:${split.id}`, cwd: split.cwd, hostId: split.hostId ?? "local" }
        : { sessionKey: activeConversationKeyRef.current, cwd: selectedProjectCwd(activeCwd(), transport().isTemporaryChat()), hostId: activeHostIdRef.current };
    });
  };
  const toggleDebugMode = () => {
    if (!settings() || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const next = { ...(settings())!, debugMode: !(settings())!.debugMode };
    void saveClientSettings(next).then(() => { setSettings(current => current ? { ...current, debugMode: next.debugMode } : current); }).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  };
  const reconnectMain = () => {
    const ownerTransport = transport(); const ownerKey = activeConversationKeyRef.current;
    if (reconnectPending.current.has(ownerTransport)) return; reconnectPending.current.add(ownerTransport); setError(undefined); updateConnected(false);
    void ownerTransport.connect().then(() => ownerTransport.loadSettings()).then((value) => activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey ? configureRuntime(value) : undefined).then(async () => {
    const capturedSession = { ...chatSession() };
 if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await capturedSession.refresh(); }).then(() => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) { setError(undefined); updateConnected(true); void syncSessionIndex(); } }).catch((reason) => { if (!isConversationChanged(reason) && activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { reconnectPending.current.delete(ownerTransport); });
  };
  useAppKeyboard({ settings, activePane, splitPane, canLeaveSettings, setView, setPanelOpen, newSession, toggleTerminal, toggleDebugMode, setSplitComposerFocusRequest, setMainComposerFocusRequest, settingsDirty, view, terminalOpen, setTerminalOpen });
  const extensionStateIsCurrent = createMemo(() => (extensionOwner() === transport()));
  const activeDialog = createMemo(() => dialogs().find((item) => !isAskUserRequest(item.request)));
  const questionContext = createConversationQuestions(dialogs, item => setDialogs(current => current.filter(dialog => dialog !== item)));
  const projectCwd = createMemo(() => (selectedProjectCwd(activeCwd(), transport().isTemporaryChat())));
  const renderMobileSidebarBackdrop = () => (panelOpen() && view() === "chat" && <button class="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);
  const mobileSidebarOpen = () => panelOpen() && view() === "chat";
  const renderMobileSidebarToggle = () => <button type="button" class="mobile-sidebar-toggle" aria-label="Toggle conversations" aria-expanded={mobileSidebarOpen()} onClick={() => { if (canLeaveSettings()) { const open = !mobileSidebarOpen(); setView("chat"); setPanelOpen(open); } }}>☰</button>;
  const sidebar = createSidebarState(() => [...sessions(), ...liveSessions().filter((live) => !archives.isArchived(live) && !sessions().some((saved) => saved.id === live.id && saved.hostId === live.hostId))], query);
  const renderSidebar = () => {
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="New session group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><IconButton label={(settings())!.debugMode ? "Disable debug mode" : "Enable debug mode"} class={(settings())!.debugMode ? "active" : ""} disabled={debugModeSaving() || settingsSaving()} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label={view() === "settings" ? "Go back" : "Settings"} class={view() === "settings" ? "active" : ""} onClick={() => { if (view() !== "settings") { setView("settings"); return; } if (canLeaveSettings()) setView("chat"); }}>{view() === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}{panelOpen() && view() === "chat" && renderMobileSidebarToggle()}</nav>);
    const renderSessionPanel = () => (view() === "chat" && panelOpen() && <SessionPanel debug={settings()?.debugMode} sidebar={sidebar} activeId={chatSession().state.sessionId} activeHostId={activeHostId()} runningSessions={runningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => { const owner = transport(); void resolveBranchGroup(group).then((target) => { if (transport() === owner) return startNewSession(false, target); }).catch((reason) => addNotice({ title: "Could not open branch", message: String(reason) })); }} onCreateWorktree={(cwd, hostId) => setWorktreeTarget({ cwd, hostId, transport: transport() })} onDeleteWorktree={deleteWorktree} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} />);
    const renderUsageBadges = () => (<div class="rail-bottom">{opencodeGoBadge() && <LimitBadge clock={usageClock()} label="OpenCode Go" prefix="Go " go detail={(opencodeGoBadge())!.detail} remainingPercent={(opencodeGoBadge())!.window.remainingPercent} resetAt={(opencodeGoBadge())!.window.resetAt} />}{codexUsage() !== undefined && <LimitBadge clock={usageClock()} label="Codex" remainingPercent={(codexUsage())!.remainingPercent} resetAt={(codexUsage())!.resetAt} />}</div>);
    return (<ResizableSidebar compact={view() === "settings" || !panelOpen()}><div class="rail-branch" title={`piop development branch: ${__PIOP_DEVELOPMENT_BRANCH__}`}><GitBranch size={13} /><span>{__PIOP_DEVELOPMENT_BRANCH__}</span></div>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };
  const chatAgentProps = () => { if (!extensionStateIsCurrent()) return { agents: [], activeAgent: composerControls.agent(), agentLocked: false, agentSaved: false, agentUnavailable: false }; return { agents: (definedAgents()?.config.agents ?? []), activeAgent: composerControls.agent(definedAgents()?.active), agentLocked: definedAgents()?.locked, agentSaved: definedAgents()?.saved, agentUnavailable: definedAgents()?.unavailable }; };
  const chatModels = createMemo(() => chatSession().models.filter(model => !settings()?.hiddenModels.includes(`${model.provider}/${model.id}`)));
  const chatCommands = createMemo<SlashCommand[]>(() => [{ name: "branch-off", description: "Branch conversation [number back, default 0]", source: "builtin" }, { name: "worktree", description: "Create worktree [number back, default 0] [name]", source: "builtin" }, ...chatSession().commands.filter(command => !["branch-off", "worktree"].includes(command.name))]);
  const chatWidgets = createMemo(() => extensionStateIsCurrent() ? Object.values(widgets()).flat() : []);
  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={chatViewKey}>{(_key) => <ChatView transport={transport()}  state={composerControls.state(chatSession().state)} messages={chatSession().messages} gitDiffs={gitDiffs()} debug={(settings())!.debugMode} {...chatAgentProps()} models={chatModels()} commands={chatCommands()} thinkingLevels={composerControls.thinkingLevels(chatSession().thinkingLevels)} widgets={chatWidgets()} statuses={composerControls.statuses(extensionStateIsCurrent() ? statuses() : {})} projectCwd={projectCwd()} controlsDisabled={!connected()} selectionBtw draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} focusRequest={mainComposerFocusRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => toggleComposerTerminal("main", { sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() })} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onProjectBranch={(cwd) => openProject(cwd, activeHostId(), true)} onBranch={branch} onForkAndForget={isGitRepository() === false && projectCwd() ? forkAndForget : undefined} onCreateWorktree={isGitRepository() && projectCwd() ? (message) => setWorktreeTarget({ cwd: (projectCwd())!, hostId: activeHostId(), message, transport: transport() }) : undefined} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => transport().promptControls.toggle(composerControls.statuses(statuses()))} onThinking={setThinking} />}</Rerun>);
      const renderSplitChatPane = () => (<Show when={splitPane()}><Rerun on={() => splitPane()?.key}>{(_key) => {
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
          onOpenTerminal={() => { const current = currentPane(); if (current) toggleComposerTerminal("split", { sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onReleaseTransport={releaseSplitTransport} onSessionChange={changeSession} forkFrom={pane.btw?.forkFrom} forkLeafId={pane.btw?.leafId} initialPrompt={pane.btw?.task} initialImages={pane.btw?.images}
          onReady={pane.btw ? () => respondToBtw(pane.btw!.requestId, { value: "opened" }) : undefined}
          onFailed={pane.btw ? () => respondToBtw(pane.btw!.requestId, { cancelled: true }) : undefined}
          onClose={() => { if (currentPane()) closeSplitPane(); }} />;
      }}</Rerun></Show>);
      return (<div class={`chat-panes ${hasSidePane() ? "split" : ""}`}>
        {renderChatView()}
        {renderSplitChatPane()}
        {subagentPane() && <Rerun on={() => `${subagentPane()!.hostId}:${subagentPane()!.sessionId}`}>{(_key) => <SubagentPane target={subagentPane()!} onClose={closeSplitPane} onActivate={() => setActivePane("split")} />}</Rerun>}
      </div>);
    };
    return (<div class="chat-workspace" hidden={view() !== "chat"}>
      {renderChatPanes()}
      {terminalOpen() && <Rerun on={terminalViewKey}>{(_key) => <TerminalView  cwd={terminalLocationState().terminalCwd} terminals={terminals.state.sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={terminals.state.activeTerminal.id} output={terminals.state.activeTerminal.output} outputEnd={terminals.state.activeTerminal.outputEnd} snapshot={terminals.state.activeTerminal.snapshot} snapshotEnd={terminals.state.activeTerminal.snapshotEnd} started={terminals.state.activeTerminal.started} exited={terminals.state.activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={terminals.write} onResize={terminals.resize} onSnapshot={((sessionId: string, terminalId: string) => (value: string, outputEnd: number) => saveTerminalSnapshot(sessionId, terminalId, value, outputEnd))(terminalSessionId(), terminals.state.activeTerminal.id)} onDelete={deleteTerminal} onClose={terminals.close} />}</Rerun>}
    </div>);
  };
  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={(settings())!} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} />);
  const renderToastStack = () => (<Show when={error() || notices().length > 0}><div class="toast-stack">
      {error() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(error())!}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport())}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
      {<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
    </div></Show>);
  const renderExtensionDialog = () => (activeDialog() && !projectOpen() && !renameSession() && !worktreeTarget() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={activeDialog()!.request} owner={activeDialog()!.owner} onRespond={async (response) => {
    const capturedActiveDialog = activeDialog()!;
 await capturedActiveDialog.transport.command({ type: "extension_ui_response", id: capturedActiveDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== capturedActiveDialog)); }} />}</Rerun>);
  const renderProjectDialog = () => (projectOpen() && <ProjectDialog localEnabled={settings()?.localEnabled} initialPath={projectCwd() ?? ""} hosts={(settings())!.hosts.filter((host) => host.enabled !== false)} initialHostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const dirlessPending = new Set<string>();
  const openDirlessSession = async (session: SessionSummary, action: SessionAction | "select") => {
    const hostId = session.hostId ?? "local"; const key = `${hostId}:${session.id}`;
    if (dirlessPending.has(key)) return; dirlessPending.add(key);
    const client = transport(); const pool = runtimePool();
    try {
      await updateSessionGroups({ type: "assign", group: DIRLESS_KEY, key });
      await client.relocateDirlessSession(session.path, hostId);
      const relocated = (await client.listSessions()).find(item => item.id === session.id && (item.hostId ?? "local") === hostId);
      if (!relocated) throw new Error("The conversation could not be found after moving it to Dirless.");
      setSessions(current => current.map(item => item.id === session.id && (item.hostId ?? "local") === hostId ? relocated : item));
      const owner = pool.forSession(session); pool.setLiveSession(owner, relocated);
      await owner.restoreConnection({ cwd: relocated.cwd, sessionPath: session.path, hostId });
      if (action === "select") selectSession(relocated); else await sessionAction(relocated, action);
    } catch (reason) { addNotice({ title: "Could not open Dirless conversation", message: String(reason) }); }
    finally { dirlessPending.delete(key); }
  };
  const renderWorktreeDialog = () => (worktreeTarget() && <WorktreeDialog projectPath={(worktreeTarget())!.cwd} fromProject={!(worktreeTarget())!.message} beforePrompt={(worktreeTarget())!.message?.role === "user"} onCancel={() => setWorktreeTarget(undefined)} onCreate={(name, onSetup) => createWorktree((worktreeTarget())!, name, onSetup)} />);
  const renderSubagentFind = () => subagentPane() && <FindInPage selector=".subagent-pane .chat-shell" scopeKey={`${subagentPane()!.hostId}:${subagentPane()!.sessionId}`} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />;
  return <SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div class={`app dark ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    {!mobileSidebarOpen() && renderMobileSidebarToggle()}
    {renderMobileSidebarBackdrop()}
    {import.meta.env.MODE === "e2e" && <div class="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /></div>}
    {renderSidebar()}
    <ConversationQuestionsContext.Provider value={questionContext}>{renderChatWorkspace()}</ConversationQuestionsContext.Provider>
    {renderSettingsView()}
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
    {renderWorktreeDialog()}
  </div>)}</SubagentNavigationContext.Provider>;
}
