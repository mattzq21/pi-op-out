import { z } from "zod";
import { agentStateSchema, entrySchema } from "./lib/responseSchemas";
import { required } from "./lib/required";
import { batch,createComputed,createMemo,createSignal } from "solid-js";
import { createConversationArchive } from "./appArchive";
import { createConversationDrafts } from "./appDrafts";
import { createAppExtensions } from "./appExtensions";
import { configureConversationRuntime,createComposerControls,inheritGroupControls,newChatAgent,openDraftSession,type ProjectControls } from "./appRuntime";
import { createAppSettings } from "./appSettings";
import { selectedProjectCwd,splitConversationKey,type RenameTarget,type SplitPaneState,type TerminalTarget,type WorktreeTarget } from "./appSupport";
import { createTerminalController } from "./appTerminals";
import { createConversationViewKey,createTransportActivation,useWorkspaceDisconnect } from "./appTransportActivation";
import { createWorktreeActions } from "./appWorktrees";
import { createBranchConversation } from "./branchConversation";
import { isAskUserRequest } from "./components/AskUserDialog";
import { createConversationQuestions } from "./components/ConversationQuestions";
import { type SessionAction } from "./components/SessionPanel";
import { encodeAgentValue } from "./lib/agentProtocol";
import { isConversationChanged } from "./lib/conversationChanged";
import { branchMessages } from "./lib/messages";
import { initialWindowTarget,NativeTransport,openSessionWindow } from "./lib/nativeTransport";
import { seedChatSelection } from "./lib/newChatSelection";
import { chatSubmission,prepareChatWorktree } from "./lib/newChatWorktree";
import { resolveNewSessionBranch } from "./lib/newSessionBranch";
import { isMobile,listen } from "./lib/platform";
import { sessionDebugAction } from "./lib/sessionDebugAction";
import { DIRLESS_KEY,inheritSessionGroup,updateSessionGroups,type SessionGroup } from "./lib/sessionGroups";
import { createCachedSessionList } from "./lib/sessionListCache";
import { useSessionResume } from "./lib/sessionResume";
import { SessionRuntimePool,useTurnDiffs } from "./lib/sessionRuntimePool";
import { createSidebarState } from "./lib/sidebarState";
import { createDependencyEffect,createMemoFields,createRef,createSubscription,type StateUpdate } from "./lib/solid";
import { type SubagentTarget } from "./lib/subagentNavigation";
import { useChatSession } from "./lib/useChatSession";
import type { AppSettings, ChatMessage, ComposerUpload, ImageAttachment, Model, SessionSummary, SlashCommand } from "./types";
import { useAppEvents } from "./useAppEvents";
import { useAppKeyboard } from "./useAppKeyboard";
import { useAppUsage } from "./useAppUsage";

export { formatCodexReset,normalizeCodexUsage,normalizeOpencodeGoUsage,usageWindowsDescription } from "./appSupport";

export function createAppConversations(preloadChat: () => void) {

  const runtimePool = createMemo(() => new SessionRuntimePool());

  const [transport, setTransport] = createSignal((() => { const initial = runtimePool().create(initialWindowTarget()); runtimePool().activate(initial);

  return initial; })());

  const [view, setView] = createSignal<"chat" | "settings">("chat");
  const activeTransportRef = createRef(transport()); createComputed(() => { activeTransportRef.current = transport(); });
  const pendingSessionGroups = createRef(new WeakMap<NativeTransport, SessionGroup>());
  const initialConversationKey = createRef(`local:draft-${crypto.randomUUID()}`);
  const [activeConversationKey, setActiveConversationKey] = createSignal(initialConversationKey.current);
  const chatViewKey = createConversationViewKey(transport, activeConversationKey, () => chatSubmission(transport())?.message);
  const activeConversationKeyRef = createRef(activeConversationKey()); createComputed(() => { activeConversationKeyRef.current = activeConversationKey(); });
  const transportConversationKeys = createRef(new Map<NativeTransport, string>([[transport(), initialConversationKey.current]]));
  const liveSessionRevision = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().liveSessionRevision());

  const liveSessions = createMemo(() => { liveSessionRevision();

  return runtimePool().liveSessionSummaries(); });

  const runningSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().runningSessions());
  const unseenSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().unseenSessions());
  const pendingSettingsCount = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().pendingSettingsCount());
  const gitDiffs = useTurnDiffs(() => (runtimePool()), () => (transport()));
  const sessionRuntime = useChatSession(() => (transport()));
  const chatSession = createMemo(() => (sessionRuntime));
  const { settings, settingsSaving, debugModeSaving, settingsDirty, setSettingsDirty, loadSettings, saveSettings, toggleDebugMode } = createAppSettings({ transport, runtimePool, chatSession, addNotice: notice => addNotice(notice), preloadChat });
  const { definedAgents, setDefinedAgents, dialogs, setDialogs, mainDialogOwnerRef, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, statuses, setStatuses, widgets, setWidgets, extensionOwner, setExtensionOwner } = createAppExtensions({ transport, chatSession });
  const [sessions, setSessions] = createCachedSessionList();
  const settingsDirtyRef = createRef(settingsDirty()); createComputed(() => { settingsDirtyRef.current = settingsDirty(); });
  const sessionIndexRequest = createRef<Promise<void> | undefined>(undefined);
  const sessionIndexDirty = createRef(false);
  const [archivesOpen, setArchivesOpen] = createSignal(false);
  const [panelOpen, setPanelOpen] = createSignal((() => !window.matchMedia("(max-width: 700px)").matches)());
  const [query, setQuery] = createSignal("");
  const [connected, setConnected] = createSignal(false);
  const connectionReadyRef = createRef(connected()); createComputed(() => { connectionReadyRef.current = connected(); });
  const updateConnected = (value: boolean) => { const owned = value && activeTransportRef.current.ownsConversation(); connectionReadyRef.current = owned; setConnected(owned); };

  const [error, setError] = createSignal<string>();
  const [createGroupRequest, setCreateGroupRequest] = createSignal(0);
  const handleCreateGroup = () => setCreateGroupRequest(0);
  const [activeHostId, setActiveHostId] = createSignal((() => transport().currentHostId())());
  const [activeCwd, setActiveCwd] = createSignal<string | undefined>((() => transport().currentCwd())());
  const [isGitRepository, setIsGitRepository] = createSignal<boolean>();
  const activeHostIdRef = createRef(activeHostId()); createComputed(() => { activeHostIdRef.current = activeHostId(); });
  const { codexUsage, opencodeGoBadge, usageClock } = useAppUsage(transport);
  const [notices, setNotices] = createSignal<Array<{ id: string; title: string; message: string }>>([]);
  const addNotice = (notice: { title: string; message: string }) => setNotices((current) => [...current.slice(-9), { ...notice, id: crypto.randomUUID() }]);

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
  const pendingReviewRequest = createRef<{ id: string; transport: NativeTransport } | undefined>(undefined);

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
  const activateConversationKey = (key: string) => { setArchivesOpen(false); activeConversationKeyRef.current = key; setActiveConversationKey(key); };

  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool();
 capturedRuntimePool.setErrorHandler((message) => addNotice({ title: message.startsWith("Could not load saved project changes") || message.startsWith("Could not save project changes") ? "Project changes" : "Session", message }));

 return () => { capturedRuntimePool.setErrorHandler(); }; }, () => [addNotice, runtimePool()]);
  createDependencyEffect(() => { const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const previousKey = activeConversationKeyRef.current;

    if (!capturedSession.state.sessionId || !previousKey.includes(":draft-")) return;
    const canonicalKey = `${capturedActiveHostId}:${capturedSession.state.sessionId}`;

    if (previousKey === canonicalKey) return;
    rekeyConversationUi(previousKey, canonicalKey, capturedTransport);
  }, () => [activeHostId(), chatSession().state.sessionId, transport()]);
  createDependencyEffect(() => { const capturedTransport = transport();
    let cancelled = false;
    setIsGitRepository(undefined);
    void capturedTransport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);

    return () => { cancelled = true; };
  }, () => [transport(), sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.projectKind]);

  const latestPromptId = createMemo(() => {
    const messages = chatSession().messages;

    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") return messages[index].id;
    }
  });

  createDependencyEffect(() => {
    if (isGitRepository() !== false || !latestPromptId()) return;
    const owner = transport();
    let cancelled = false;
    void owner.isGitRepository().then(isRepository => {
      if (!cancelled && transport() === owner) setIsGitRepository(isRepository);
    }).catch(() => undefined);

    return () => { cancelled = true; };
  }, () => [transport(), latestPromptId(), chatSession().state.isStreaming, isGitRepository()]);

  const syncSessionIndex = () => {
    if (sessionIndexRequest.current) { sessionIndexDirty.current = true;

    return sessionIndexRequest.current; }

    sessionIndexDirty.current = false;

    if (!sessionIndexRequest.current) sessionIndexRequest.current = transport().listSessions().then((nextSessions) => {
      setSessions(nextSessions.filter((session) => !runtimePool().isRemoved(session) && !archives.isArchived(session)));
      chatSession().setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId && (session.hostId ?? "local") === activeHostIdRef.current);

        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch(() => undefined).finally(() => { sessionIndexRequest.current = undefined;

    if (sessionIndexDirty.current) void syncSessionIndex(); });

    return sessionIndexRequest.current;
  };

  createDependencyEffect(() => {
    const unsubscribes = [
      listen("pi://sessions-changed", () => { void syncSessionIndex(); }, z.unknown()),
      listen("pi://session-removed", ({ payload }) => {
        runtimePool().removeSummary(payload.hostId ?? "local", payload.sessionPath);
        setSessions((current) => current.filter((session) => !runtimePool().isRemoved(session)));
        void syncSessionIndex();
      }, z.object({ hostId: z.string().optional(), sessionPath: z.string() })),
      listen("pi://daemon-error", ({ payload }) => addNotice({ title: `Connection · ${payload.hostId}`, message: payload.line }), z.object({ hostId: z.string(), line: z.string() })),
    ];

    return () => { for (const pending of unsubscribes) void pending.then((unlisten) => unlisten()); };
  }, () => [addNotice, syncSessionIndex]);

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

  const projectControls = new WeakMap<NativeTransport, ProjectControls>();
  const composerControls = createComposerControls(transport, connected, projectControls, () => definedAgents()?.config.fastModeModels);
  const configureRuntime = (value: AppSettings) => configureConversationRuntime(value, transport(), () => activeTransportRef.current, projectControls);
  const reviewImages = new WeakMap<NativeTransport, ImageAttachment[]>();
  const resolveHomeDirectory = (hostId: string) => transport().homeDirectory(hostId);
  useAppEvents(() => ({ transport: transport(), handleEvent: chatSession().handleEvent, setDialogs, loadSettings, refresh, queueTerminalOutput, terminalExited: terminals.exited, addNotice, activeTransportRef, pendingReviewRequest, reviewImages, setSplitPane, activeHostIdRef, setExtensionOwner, setDefinedAgents, refreshSession: chatSession().refresh, setStatuses, setWidgets, setComposerDraft, transportConversationKeys, terminalSessionId, setActivePane, setMainComposerFocusRequest, queueExtensionDialog, mainDialogOwnerRef, setActiveHostId, setActiveCwd, activateConversationKey, setTerminalOpen, setTerminalTarget, configureRuntime, setError, updateConnected, flushTerminalOutput: terminals.flushOutput }));
  createDependencyEffect(() => {
    const capturedTransport = transport(); const capturedRuntimePool = runtimePool();
 const shutdown = () => { for (const id of terminals.allTerminalIds()) void capturedTransport.closeTerminal(id).catch(() => undefined); void capturedRuntimePool.disconnectAll(); };

 window.addEventListener("pagehide", shutdown);

 return () => window.removeEventListener("pagehide", shutdown); }, () => [runtimePool(), transport()]);
  createDependencyEffect(() => {
    const capturedSettingsDirty = settingsDirty();

 if (!capturedSettingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };

 window.addEventListener("beforeunload", warn);

 return () => window.removeEventListener("beforeunload", warn); }, () => [settingsDirty()]);
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool(); const capturedView = view(); const capturedTransport = transport();
 capturedRuntimePool.activate(capturedView === "chat" ? capturedTransport : undefined); }, () => [runtimePool(), transport(), view()]);

  const parseBranchCommand = (branchCommand: RegExpExecArray) => {
    const [, command, rawArgs = ""] = branchCommand;
    const args = rawArgs.trim().split(/\s+/).filter(Boolean);
    const hasNumber = args.length > 0 && /^[+-]?\d/.test(args[0]);
    const number = hasNumber ? required(args.shift()) : "0";

    if (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error("The response number must be a non-negative integer");

    if (command === "branch-off" && args.length) throw new Error("Usage: /branch-off [number]");
    const responses = chatSession().messages.filter((message) => message.role === "assistant" && message.entryId && !message.streaming && message.stopReason !== "toolUse" && (message.stopReason === "aborted" || message.stopReason === "error" || (Array.isArray(message.content) ? message.content.some((part) => part.type === "text" && part.text?.trim()) : message.content.trim())));
    const message = responses.at(-1 - Number(number));

    if (!message) throw new Error(`No response exists ${number} responses back`);

    return { command, args, message };
  };

  const sendBranchCommand = async (branchCommand: RegExpExecArray, images: ImageAttachment[]) => { const capturedBranchConversation = branchConversation(); const capturedIsGitRepository = isGitRepository(); const capturedProjectCwd = projectCwd(); const capturedActiveHostId = activeHostId(); const capturedTransport = transport();

    if (images.length) throw new Error("Branch commands do not accept attachments");
    const { command, args, message } = parseBranchCommand(branchCommand);

    if (command === "branch-off") return capturedBranchConversation(message);

    if (!capturedIsGitRepository || !capturedProjectCwd) throw new Error("Open a Git project before creating a worktree");
    const target = { cwd: (capturedProjectCwd), hostId: capturedActiveHostId, message, transport: capturedTransport };

    if (!args.length) { setWorktreeTarget(target);

    return true; }

    await createWorktree(target, args.join(" "));

    return true;
  };

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => { const capturedTransport = await prepareChatWorktree(transport(), async (cwd, host, onActivate) => { const group = pendingSessionGroups.current.get(transport()); await openProject(cwd, host, true, onActivate);

  if (group) pendingSessionGroups.current.set(transport(), group); }, transport, connected, error);

    if (!connectionReadyRef.current) throw new Error("piop is still connecting");
    const ownerTransport = capturedTransport;
    const imagePayload = images.length ? { images } : {};

    if (/^\/review(?:\s|$)/.test(text.trim())) reviewImages.set(capturedTransport, images);
    const branchCommand = /^\/(worktree|branch-off)(?:\s+(.*))?$/s.exec(text.trim());

    if (branchCommand) {
      return sendBranchCommand(branchCommand, images);
    }

    try {
    if (behavior) { await ownerTransport.submitPrompt({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...imagePayload });

    return; }

    await capturedTransport.submitPrompt({ type: "prompt", message: text, ...imagePayload });

    return true;
    } catch (reason) { addNotice({ title: "Could not send message", message: reason instanceof Error ? reason.message : String(reason) }); throw reason; }
  };

  const respondToReview = (requestId: string, response: { value?: string; cancelled?: boolean }) => {
    const pending = pendingReviewRequest.current;

    if (!pending || pending.id !== requestId) return;
    pendingReviewRequest.current = undefined;
    void pending.transport.command({ type: "extension_ui_response", id: requestId, ...response }).catch((reason) => addNotice({ title: "Could not finish /review request", message: reason instanceof Error ? reason.message : String(reason) }));
  };

  const closeSplitPane = () => { if (splitPane()?.review) respondToReview(required(required((splitPane())).review).requestId, { cancelled: true }); setSplitPane(undefined); setSubagentPane(undefined); setActivePane("main"); };

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

    if (!entryId) { addNotice({ title: "Could not fork and forget", message: "Could not find the selected assistant response" });

    return; }

    const pendingKey = `${ownerKey}:forget:${entryId}`;

    if (branchPending.current.has(pendingKey)) return;
    branchPending.current.add(pendingKey);

    try {
      if (conversationBusy()) throw new Error("Wait for the current response and queued messages to finish first");
      const result = await ownerTransport.command({ type: "fork_and_forget", entryId }, z.object({ cancelled: z.boolean().optional() }));

      if (result.cancelled) return;

      const [nextState, history] = await Promise.all([
        ownerTransport.command({ type: "get_state" }, agentStateSchema),
        ownerTransport.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) })),
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

  const createSessionTransport = (cwd: string | undefined, hostId: string) => { const owner = runtimePool().create(cwd ? { cwd, hostId } : { hostId }); seedChatSelection(owner, cwd, hostId, [...sessions(), ...liveSessions()]);

  return owner; };

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
    setArchivesOpen(false);
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
    setArchivesOpen(false);
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
  const isSplitSession = (session: SessionSummary) => splitPane()?.session.id === session.id && (required((splitPane())).session.hostId ?? "local") === (session.hostId ?? "local");
  const isSelectedSession = (session: SessionSummary) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId();
  const closeSplitForSession = (session: SessionSummary) => { if (isSplitSession(session) || splitPane()?.review) closeSplitPane(); };

  const selectSession = (session: SessionSummary) => {
    if (!canLeaveSettings()) return undefined;
    setArchivesOpen(false);
    lastNewSessionSelection.current = undefined;

    if (window.matchMedia("(max-width: 700px)").matches) setPanelOpen(false);

    if (archives.isPending(session)) return undefined;
    const hostId = session.hostId ?? "local";

    if (isSelectedSession(session)) { if (!connected()) reconnectMain();

    return transport(); }

    closeSplitForSession(session);

    if (session.cwdExists === false) { void openDirlessSession(session, "select");

    return undefined; }

    const nextTransport = runtimePool().forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); chatSession().discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); activateTransport(nextTransport);

    return nextTransport;
  };

  const setModel = (model: Model) => transport().promptControls.model(model, composerControls.state(chatSession().state).thinkingLevel);
  const setThinking = (level: string) => transport().promptControls.thinking(level);

  const abortInteraction = async () => {
    const capturedTransport = transport();
 const ownerTransport = capturedTransport;

 if (abortPending.current.has(ownerTransport)) return; abortPending.current.add(ownerTransport);

 try { await ownerTransport.command({ type: "abort" }); } catch (reason) { addNotice({ title: "Could not stop piop", message: reason instanceof Error ? reason.message : String(reason) }); } finally { abortPending.current.delete(ownerTransport); } };

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

  const setAgent = async (name: string) => {
    const capturedTransport = transport();

 try { await capturedTransport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }); capturedTransport.promptControls.reset(); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };

  const openProject = async (cwd: string, hostId: string, fromBranch = false, onActivate?: (destination: NativeTransport) => void) => {
    const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool(); const capturedComposerState = { ...composerState() };

 if (!canLeaveSettings()) return; const controls = { agent: newChatAgent(definedAgents(), settings()?.defaultAgent), model: composerControls.state(capturedSession.state).model, thinking: composerControls.state(capturedSession.state).thinkingLevel, fastMode: composerControls.statuses(statuses())["pi-desktop-fast-mode"] === "Fast mode on", contextWindow: capturedSession.state.contextUsage?.contextWindow }; const request = projectOpenRequest.current; const validatedCwd = await capturedTransport.validateProjectDirectory(cwd, hostId, fromBranch);

 if (capturedTransport !== activeTransportRef.current || (!fromBranch && (!projectOpenRef.current || request !== projectOpenRequest.current))) return; batch(() => { const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); capturedSession.discardPendingUpdates(); activateConversationKey(conversationKey); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = capturedRuntimePool.create({ cwd: validatedCwd, hostId }); projectControls.set(nextTransport, controls); transportConversationKeys.current.set(nextTransport, conversationKey); setComposerDraft(conversationKey, capturedComposerState.composerDraft); setComposerUploads(nextTransport, capturedComposerState.composerUploads); onActivate?.(nextTransport); activateTransport(nextTransport); }); };

  const chooseChatProject = () => { projectOpenRequest.current += 1; setProjectOpen(true); };

  const openSplitPane = (session: SessionSummary) => { closeSplitPane(); setSplitPane({ key: crypto.randomUUID(), session }); };

  const openSessionDirectory = async (session: SessionSummary) => { const capturedTransport = transport();
    const actionKey = `open-directory:${session.hostId ?? "local"}:${session.id}`;

    if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);

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
    const sourcePath = session.path; const previousKey = `${hostId}:${session.id}`;

    try { await selectedTransport.connect(); const sourceDiffs = await capturedRuntimePool.captureMemoryDiffs(selectedTransport); const cloned = await selectedTransport.command({ type: "clone" }, z.object({ cancelled: z.boolean().optional() }));

    if (cloned.cancelled) return; const nextState = await selectedTransport.command({ type: "get_state" }, agentStateSchema); await inheritSessionGroup(previousKey, `${hostId}:${nextState.sessionId}`, session); capturedRuntimePool.bind(hostId, nextState.sessionId, selectedTransport); rekeyConversationUi(previousKey, `${hostId}:${nextState.sessionId}`, selectedTransport, true, true);

    if (!selectedTransport.isEphemeral()) { const sourceTransport = capturedRuntimePool.forSession(session); drafts.copyUploads(selectedTransport, sourceTransport); }

    const history = await selectedTransport.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) })); const nextMessages = branchMessages(history.entries, history.leafId);

    if (activeTransportRef.current === selectedTransport) { capturedSession.setState(nextState); capturedSession.setMessages(nextMessages); updateConnected(true); }

    try { await capturedRuntimePool.copySavedDiffs(selectedTransport, sourcePath, nextState.sessionFile, new Set(nextMessages.map((entry) => entry.id)), sourceDiffs); } catch (reason) { addNotice({ title: "Conversation cloned, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); }

    await syncSessionIndex(); } catch (reason) { addNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
  };

  const cloneSession = async (session: SessionSummary, action: SessionAction) => {
    const actionKey = `${action}:${session.hostId ?? "local"}:${session.id}`;

    if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);

    try {
      const selectedTransport = selectSession(session);

      if (!selectedTransport) return;

      if (action === "clone") { await cloneSelectedSession(session, selectedTransport); }
    } finally { sessionActionPending.current.delete(actionKey); }
  };

  const openSessionInWindow = async (session: SessionSummary) => { if (isMobile) { selectSession(session);

  return; }

  try { await openSessionWindow({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id, hostId: session.hostId }); } catch (reason) { addNotice({ title: "Could not open window", message: String(reason) }); } };

  const sessionAction = async (session: SessionSummary, action: SessionAction) => { const capturedRuntimePool = runtimePool();

    if (["copy-id", "open-rollout"].includes(action)) { await sessionDebugAction(session, action, addNotice);

    return; }

    if (session.cwdExists === false && action !== "archive" && action !== "open-directory") { await openDirlessSession(session, action);

    return; }

    if (action === "split") { openSplitPane(session);

    return; }

    if (action === "new-window") return openSessionInWindow(session);

    if (action === "open-directory") return openSessionDirectory(session);

    if (action === "archive") return archiveSession(session);

    if (action === "rename") { setRenameSession({ session, transport: capturedRuntimePool.forSession(session) });

    return; }

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
  const mobileSidebarOpen = () => panelOpen() && view() === "chat";
  const sidebar = createSidebarState(() => [...sessions(), ...liveSessions().filter((live) => !archives.isArchived(live) && !sessions().some((saved) => saved.id === live.id && saved.hostId === live.hostId))], query);

  const chatAgentProps = () => { if (!extensionStateIsCurrent()) return { agents: [], activeAgent: composerControls.agent(), agentLocked: false, agentSaved: false, agentUnavailable: false };

  return { agents: (definedAgents()?.config.agents ?? []), activeAgent: composerControls.agent(definedAgents()?.active), agentLocked: definedAgents()?.locked, agentSaved: definedAgents()?.saved, agentUnavailable: definedAgents()?.unavailable }; };

  const chatModels = createMemo(() => chatSession().models.filter(model => !settings()?.hiddenModels.includes(`${model.provider}/${model.id}`)));
  const chatCommands = createMemo<SlashCommand[]>(() => [{ name: "branch-off", description: "Branch conversation [number back, default 0]", source: "builtin" }, { name: "worktree", description: "Create worktree [number back, default 0] [name]", source: "builtin" }, ...chatSession().commands.filter(command => !["branch-off", "worktree"].includes(command.name))]);
  const chatWidgets = createMemo(() => extensionStateIsCurrent() ? Object.values(widgets()).flat() : []);
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

 return { archivesOpen, setArchivesOpen, runtimePool, transport, view, setView, activeConversationKey, chatViewKey, runningSessions, unseenSessions, pendingSettingsCount, gitDiffs, chatSession, sessions, settings, settingsSaving, debugModeSaving, setSettingsDirty, panelOpen, setPanelOpen, query, setQuery, connected, error, setError, createGroupRequest, setCreateGroupRequest, handleCreateGroup, activeHostId, isGitRepository, codexUsage, usageClock, opencodeGoBadge, setDialogs, notices, setNotices, addNotice, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, releaseSplitTransport, statuses, widgets, renameSession, setRenameSession, projectOpen, setProjectOpen, worktreeTarget, setWorktreeTarget, projectOpenRef, uploadsByTransport, setComposerDraft, setComposerUploads, splitPane, setSplitPane, subagentPane, hasSidePane, mainComposerFocusRequest, splitComposerFocusRequest, activePane, setActivePane, terminals, terminalOpen, terminalSessionId, terminalLocationState, startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal, reconnectPending, splitSessionId, composerState, terminalViewKey, syncSessionIndex, composerControls, resolveHomeDirectory, send, respondToReview, closeSplitPane, openSubagent, canLeaveSettings, rekeyConversationUi, createWorktree, deleteWorktree, branch, forkAndForget, startNewSession, newSession, clearChatProject, selectSession, setModel, setThinking, abortInteraction, pauseInteraction, resumeInteraction, saveSettings, setAgent, openProject, chooseChatProject, sessionAction, draftChangeFor, uploadsChangeFor, toggleComposerTerminal, toggleDebugMode, reconnectMain, extensionStateIsCurrent, activeDialog, questionContext, projectCwd, mobileSidebarOpen, sidebar, chatAgentProps, chatModels, chatCommands, chatWidgets };
}
