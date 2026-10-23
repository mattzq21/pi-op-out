import { z } from "zod";
import { createMutable } from "solid-js/store";
import { required } from "./lib/required";
import { fastModelNames, hostFastModels } from "./lib/fastModels";
import { batch,createComputed,createMemo,createSignal,onCleanup } from "solid-js";
import { showBackgroundErrors } from "./lib/backgroundErrors";
import { createConversationArchive } from "./appArchive";
import { createConversationDrafts } from "./appDrafts";
import { createAppExtensions } from "./appExtensions";
import { configureConversationRuntime,createComposerControls } from "./appRuntime";
import { createAppSettings } from "./appSettings";
import { selectedProjectCwd,splitConversationKey,type RenameTarget,type SplitPaneState,type TerminalTarget } from "./appSupport";
import { createTerminalController } from "./appTerminals";
import { createConversationViewKey,createTransportActivation,useWorkspaceDisconnect } from "./appTransportActivation";
import { createBranchConversation } from "./branchConversation";
import { type SessionAction } from "./components/SessionPanel";
import type { MissingDirectoryRequest } from "./components/MissingDirectoryDialog";
import { isConversationChanged } from "./lib/conversationChanged";
import { initialWindowTarget,NativeTransport,openSessionWindow } from "./lib/nativeTransport";
import { chatSubmission,waitForConversationReady } from "./lib/chatSubmission";
import { splitPaneCommand } from "./plugins";
import { promptWasAccepted, submitDraftPrompt } from "./lib/draftSubmission";
import { isMobile,listen } from "./lib/platform";
import { sessionDebugAction } from "./lib/sessionDebugAction";
import { updateSessionGroups,type SessionGroup } from "./lib/sessionGroups";
import { createCachedSessionList } from "./lib/sessionListCache";
import { useSessionResume } from "./lib/sessionResume";
import { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { createSidebarState } from "./lib/sidebarState";
import { createDependencyEffect,createMemoFields,createRef,createSubscription,type StateUpdate } from "./lib/solid";
import { type SubagentTarget } from "./lib/subagentNavigation";
import { useChatSession } from "./lib/useChatSession";
import type { AppSettings, ChatMessage, ComposerUpload, ForkSource, ImageAttachment, Model, SessionSummary, SlashCommand } from "./types";
import { useAppEvents } from "./useAppEvents";
import { useAppKeyboard } from "./useAppKeyboard";
import { useAppUsage } from "./useAppUsage";
import { isDaemonRefusal } from "./lib/commandRejected";

export { formatCodexReset,normalizeCodexUsage,normalizeOpencodeGoUsage,usageWindowsDescription } from "./appSupport";

const removedSessionSchema = z.object({ hostId: z.string().optional(), sessionPath: z.string().nullish().transform(path => path ?? undefined), sessionId: z.string().optional() });

type RemovedSession = z.infer<typeof removedSessionSchema>;

const removedSessionHost = (removed: RemovedSession) => removed.hostId ?? "local";

function removedSessionMatches(hostId: string | undefined, sessionId: string, sessionPath: string | undefined, removed: RemovedSession) {
  return (hostId ?? "local") === (removed.hostId ?? "local") && (sessionId === removed.sessionId || Boolean(removed.sessionPath && sessionPath === removed.sessionPath));
}

export function createAppConversations(preloadChat: () => void) {
  const runtimePool = createMemo(() => new SessionRuntimePool());
  const initialTarget = initialWindowTarget();
  const drafts = createConversationDrafts(message => addNotice({ title: "Could not save drafts", message }));

  const [transport, setTransport] = createSignal((() => { const initial = runtimePool().create(initialTarget); runtimePool().activate(initial);

    return initial; })());

  const [view, setView] = createSignal<"chat" | "settings">("chat");
  const activeTransportRef = createRef(transport()); createComputed(() => { activeTransportRef.current = transport(); });
  const pendingSessionGroups = createRef(new WeakMap<NativeTransport, SessionGroup>());
  const initialConversationKey = createRef(initialTarget.draftKey ?? (initialTarget.sessionId ? `${initialTarget.hostId ?? "local"}:${initialTarget.sessionId}` : `${initialTarget.hostId ?? "local"}:draft-${crypto.randomUUID()}`));
  const [activeConversationKey, setActiveConversationKey] = createSignal(initialConversationKey.current);
  const chatViewKey = createConversationViewKey(transport, activeConversationKey, () => chatSubmission(transport())?.message);
  const activeConversationKeyRef = createRef(activeConversationKey()); createComputed(() => { activeConversationKeyRef.current = activeConversationKey(); });
  const transportConversationKeys = createRef(new Map<NativeTransport, string>([[transport(), initialConversationKey.current]]));
  const liveSessionRevision = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().liveSessionRevision());

  const liveSessions = createMemo(() => { liveSessionRevision();
    const live = runtimePool().liveSessionSummaries().filter(session => !session.isDraft || drafts.hasDraft(`${session.hostId ?? "local"}:${session.id}`));

    return [...live, ...drafts.draftSummaries().filter(draft => !live.some(session => (session.hostId ?? "local") === (draft.hostId ?? "local") && (session.id === draft.id || Boolean(draft.path && draft.path === session.path))))]; });

  const runningSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().runningSessions());
  const unseenSessions = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().unseenSessions());
  const pendingSettingsCount = createSubscription(() => (listener) => runtimePool().subscribe(listener), () => () => runtimePool().pendingSettingsCount());

  const sessionRuntime = useChatSession(() => (transport()));
  const chatSession = createMemo(() => (sessionRuntime));
  const { modelVisibility, settings, settingsSaving, debugModeSaving, settingsDirty, setSettingsDirty, loadSettings, saveSettings, toggleDebugMode, toggleDebugFeature } = createAppSettings({ transport, runtimePool, chatSession, addNotice: notice => addNotice(notice), preloadChat });
  const { definedAgents, setDefinedAgents, dialogs, setDialogs, mainDialogOwnerRef, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, cancelTransportDialogs, statuses, setStatuses, widgets, setWidgets, extensionOwner, setExtensionOwner } = createAppExtensions({ transport, chatSession });
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
  /** Counts new chats started from the navigation; the chat list closes its new-group form on each. */
  const [newChatRequest, setNewChatRequest] = createSignal(0);
  const [activeHostId, setActiveHostId] = createSignal((() => transport().currentHostId())());
  const [activeCwd, setActiveCwd] = createSignal<string | undefined>((() => transport().currentCwd())());
  const activeHostIdRef = createRef(activeHostId()); createComputed(() => { activeHostIdRef.current = activeHostId(); });
  const { codexUsage, opencodeGoBadge, usageClock, codexUsageError, opencodeGoUsageError } = useAppUsage(transport);
  const [notices, setNotices] = createSignal<Array<{ id: string; title: string; message: string }>>([]);

  const addNotice = (notice: { title: string; message: string }) => {
    let id: string = crypto.randomUUID();
    setNotices(current => {
      const shown = current.find(item => item.title === notice.title && item.message === notice.message);

      if (shown) { id = shown.id; return current; }
      while (current.some(item => item.id === id)) id = crypto.randomUUID();
      return [...current.filter((item, index) => item.id.startsWith("daemon-log:") || index >= current.length - 9), { ...notice, id }];
    });

    return () => setNotices(current => current.filter(item => item.id !== id));
  };
  onCleanup(showBackgroundErrors(addNotice));

  const hasRetainedDraft = (ownerTransport: NativeTransport) => {
    const key = transportConversationKeys.current.get(ownerTransport);

    return transportHasDraft(ownerTransport, key) || runtimePool().liveSessionSummaries().some(session => session.isDraft && `${session.hostId ?? "local"}:${session.id}` === key);
  };

  const releaseSplitTransport = async (ownerTransport: NativeTransport) => { const capturedRuntimePool = runtimePool();

    if (activeTransportRef.current === ownerTransport || capturedRuntimePool.isInteractive(ownerTransport)) return;
    await cancelTransportDialogs(ownerTransport).catch((reason) => addNotice({ title: "Could not cancel extension dialog", message: reason instanceof Error ? reason.message : String(reason) }));

    if (hasRetainedDraft(ownerTransport)) return;

    if (ownerTransport.currentSessionPath() && (uploadsByTransport().get(ownerTransport)?.length ?? 0) > 0) return;

    if (activeTransportRef.current !== ownerTransport) await capturedRuntimePool.release(ownerTransport);
  };

  const [renameSession, setRenameSession] = createSignal<RenameTarget>();
  const [projectOpen, setProjectOpen] = createSignal(false);
  const projectOpenRef = createRef(projectOpen()); createComputed(() => { projectOpenRef.current = projectOpen(); });
  const projectOpenRequest = createRef(0);
  const { composerDrafts, uploadsByTransport, setComposerDraft, setComposerUploads, transportHasDraft } = drafts;
  const draftSessions = drafts.draftSummaries;
  createDependencyEffect(() => {
    const current = settings();

    if (current) drafts.configureHosts(current);
  }, () => [settings()]);
  drafts.bindTransport(transport(), initialConversationKey.current);
  createDependencyEffect(() => drafts.bindTransport(transport(), activeConversationKey()), () => [transport(), activeConversationKey(), activeCwd(), connected()]);
  const newSessionPending = createRef(false);
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
  const pendingSplitRequest = createRef<{ id: string; transport: NativeTransport; command: string } | undefined>(undefined);

  const terminals = createTerminalController({
    transport, conversationKey: activeConversationKey, addNotice,
    sessionTransport: key => {
      if (key === activeConversationKey()) return transport();
      const pane = splitPane();

      if (pane && splitConversationKey(pane) === key) return runtimePool().forSession(pane.session);

      return [...transportConversationKeys.current].find(([, value]) => value === key)?.[0];
    },
    location: () => ({ cwd: activeCwd() ?? sessions().find(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.cwd, hostId: activeHostId() }),
  });

  const { terminalOpen, setTerminalOpen, setTerminalTarget, terminalSessionId, terminalLocationState, conversationTerminalIds, queueTerminalOutput, startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal } = terminals;
  const reconnectPending = createRef(new Set<NativeTransport>());
  useSessionResume(() => {
    const saved = chatSession().state.messageCount > 0;

    return { ready: connected(), saved, target: { sessionId: chatSession().state.sessionId, sessionPath: chatSession().state.sessionFile, cwd: !saved && transport().isTemporaryChat() ? undefined : transport().currentCwd(), hostId: activeHostId(), draftKey: transportHasDraft(transport(), activeConversationKey()) ? activeConversationKey() : undefined } };
  });
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

  const activateConversationKey = (key: string) => { setArchivesOpen(false);

    if (key !== activeConversationKeyRef.current) setTerminalTarget(undefined); activeConversationKeyRef.current = key; setActiveConversationKey(key); };

  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool();
    capturedRuntimePool.setErrorHandler((message) => addNotice({ title: message.startsWith("Could not load saved project changes") || message.startsWith("Could not save project changes") ? "Project changes" : "Session", message }));

    return () => { capturedRuntimePool.setErrorHandler(); }; }, () => [addNotice, runtimePool()]);
  createDependencyEffect(() => { const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const previousKey = activeConversationKeyRef.current;

    if (!connected() || !capturedSession.state.sessionFile || capturedSession.state.messageCount === 0 || !capturedSession.state.sessionId || (!previousKey.includes(":draft-") && !drafts.records()[previousKey]?.target?.draftKey)) return;
    const canonicalKey = `${capturedActiveHostId}:${capturedSession.state.sessionId}`;

    if (previousKey === canonicalKey) return;
    rekeyConversationUi(previousKey, canonicalKey, capturedTransport);
  }, () => [activeHostId(), chatSession().state.sessionId, chatSession().state.sessionFile, chatSession().state.messageCount, connected(), transport()]);

  const archiveCount = createRef(0);
  let daemonRestarting = false;
  let daemonConnectionGeneration = 0;
  const syncSessionIndex = () => {
    if (daemonRestarting) { sessionIndexDirty.current = true; return Promise.resolve(); }
    if (sessionIndexRequest.current) { sessionIndexDirty.current = true;

      return sessionIndexRequest.current; }

    sessionIndexDirty.current = false;
    const listedAfter = archiveCount.current;
    const connectionGeneration = daemonConnectionGeneration;

    if (!sessionIndexRequest.current) sessionIndexRequest.current = transport().listSessions().then((nextSessions) => {
      if (daemonRestarting || connectionGeneration !== daemonConnectionGeneration) { sessionIndexDirty.current = true; return; }
      for (const session of nextSessions) {
        if (archives.isPending(session)) continue;
        const hostId = session.hostId ?? "local";
        archives.restored(hostId, session.id, listedAfter);

        if (session.path) runtimePool().restoreSummary(hostId, session.path);
      }

      setSessions(nextSessions.filter((session) => !runtimePool().isRemoved(session) && !archives.isArchived(session)));
      chatSession().setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId && (session.hostId ?? "local") === activeHostIdRef.current);

        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch((reason) => { if (daemonRestarting || connectionGeneration !== daemonConnectionGeneration) { sessionIndexDirty.current = true; return; } addNotice({ title: "Could not load chats", message: reason instanceof Error ? reason.message : String(reason) }); }).finally(() => { sessionIndexRequest.current = undefined;

      if (sessionIndexDirty.current && !daemonRestarting) void syncSessionIndex(); });

    return sessionIndexRequest.current;
  };

  createDependencyEffect(() => {
    if (connected()) void syncSessionIndex();
  }, () => [connected()]);

  createDependencyEffect(() => {
    const unsubscribes = [
      listen("pi://daemon-restarting", ({ payload }) => {
        if (payload.hostId !== "local") return;
        daemonRestarting = true;
        daemonConnectionGeneration++;
      }, z.object({ hostId: z.string() })),
      listen("pi://event", ({ payload }) => {
        if (payload.type !== "connection_restored") return;
        daemonRestarting = false;
        void syncSessionIndex();
      }, z.object({ type: z.string().optional() })),
      listen("pi://sessions-changed", () => { void syncSessionIndex(); }, z.unknown()),
      listen("pi://session-restored", ({ payload }) => {
        archives.restored(payload.hostId, payload.sessionId);
        runtimePool().restoreSummary(payload.hostId, payload.sessionPath);
        void syncSessionIndex();
      }, z.object({ hostId: z.string(), sessionId: z.string(), sessionPath: z.string() })),
      listen("pi://session-removed", async ({ payload }) => {
        if (!await archives.removed(payload.hostId ?? "local", payload.sessionPath, payload.sessionId)) return;
        const split = splitPane()?.session;

        if (split && removedSessionMatches(split.hostId, split.id, split.path, payload) && !archives.isPending(split)) closeSplitPane();
        const subagent = subagentPane();

        if (subagent && removedSessionMatches(subagent.hostId, subagent.sessionId, subagent.sessionPath, payload)) closeSplitPane();

        if (payload.sessionPath) runtimePool().removeSummary(removedSessionHost(payload), payload.sessionPath);
        setSessions((current) => current.filter((session) => !runtimePool().isRemoved(session) && !archives.isArchived(session)));
        void syncSessionIndex();
      }, removedSessionSchema),
      listen("pi://daemon-log-status", ({ payload }) => {
        const id = `daemon-log:${payload.hostId}`;
        setNotices(current => {
          const existing = current.find(item => item.id === id);
          if (payload.failure === null) return existing ? current.filter(item => item.id !== id) : current;
          if (existing?.message === payload.failure) return current;
          if (existing) { existing.message = payload.failure; return current; }
          return [...current, createMutable({ id, title: `Logging · ${payload.hostId}`, message: payload.failure })];
        });
      }, z.object({ hostId: z.string(), failure: z.string().nullable() })),
      listen("pi://daemon-error", ({ payload }) => { if (payload.hostId === "local") daemonRestarting = false; addNotice({ title: `Connection · ${payload.hostId}`, message: payload.line }); }, z.object({ hostId: z.string(), line: z.string() })),
    ];

    return () => { for (const pending of unsubscribes) void pending.then((unlisten) => unlisten()); };
  }, () => [addNotice, syncSessionIndex]);

  const refreshSession = async (hostId?: string) => { const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool();
    const nextState = await capturedSession.refresh(); capturedRuntimePool.bind(hostId ?? capturedTransport.currentHostId(), nextState.sessionId, capturedTransport);
    const group = pendingSessionGroups.current.get(capturedTransport);

    if (group && nextState.sessionId && nextState.messageCount > 0) {
      try {
        const key = `${hostId ?? capturedTransport.currentHostId()}:${nextState.sessionId}`; await updateSessionGroups(group.cwd ? { type: "project", key, project: group } : { type: "assign", key, group: group.id });
        pendingSessionGroups.current.delete(capturedTransport);
      } catch (reason) { addNotice({ title: "Could not add chat to group", message: reason instanceof Error ? reason.message : String(reason) }); }
    }

    return nextState;
  };

  const refresh = async (hostId?: string, loadedSettings?: AppSettings) => {
    void syncSessionIndex();
    const settingsRequest = loadedSettings ? Promise.resolve(settings() ?? loadedSettings) : loadSettings();
    const [, nextSettings] = await Promise.all([refreshSession(hostId), settingsRequest]);

    return nextSettings;
  };

  const composerControls = createComposerControls(transport, () => fastModelNames(hostFastModels(activeHostId())()));
  const configureRuntime = (value: AppSettings) => configureConversationRuntime(value, transport(), () => activeTransportRef.current);
  const commandImages = new WeakMap<NativeTransport, ImageAttachment[]>();
  const resolveHomeDirectory = (hostId: string) => transport().homeDirectory(hostId);

  const prepareSession = async (owner: NativeTransport) => {
    const target = owner.connectionTarget();

    if (!target.sessionPath || !target.cwd) return true;

    try { await owner.validateProjectDirectory(target.cwd, target.hostId ?? "local", true);

      return true; }
    catch (reason) {
      const session = (await owner.listSessions()).find(item => item.path === target.sessionPath && (item.hostId ?? "local") === (target.hostId ?? "local"));

      if (!session || session.cwdExists !== false) throw reason;

      if (transport() === owner) await openDirlessSession(session, "select");

      return false;
    }
  };

  useAppEvents(() => ({ transport: transport(), prepareSession, handleEvent: chatSession().handleEvent, setDialogs, loadSettings, refresh, queueTerminalOutput, terminalExited: terminals.exited, addNotice, activeTransportRef, pendingSplitRequest, commandImages, setSplitPane, activeHostIdRef, setExtensionOwner, setDefinedAgents, refreshSession, setStatuses, setWidgets, setComposerDraft, transportConversationKeys, terminalSessionId, setActivePane, setMainComposerFocusRequest, queueExtensionDialog, mainDialogOwnerRef, setActiveHostId, setActiveCwd, activateConversationKey, setTerminalOpen, setTerminalTarget, configureRuntime, setError, updateConnected, flushTerminalOutput: terminals.flushOutput }));
  createDependencyEffect(() => {
    const capturedTransport = transport(); const capturedRuntimePool = runtimePool();
    const shutdown = () => { for (const id of terminals.draftTerminalIds()) void capturedTransport.closeTerminal(id).catch(() => undefined); void capturedRuntimePool.disconnectAll(); };

    window.addEventListener("pagehide", shutdown);

    return () => window.removeEventListener("pagehide", shutdown); }, () => [runtimePool(), transport()]);
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool(); const capturedView = view(); const capturedTransport = transport();
    capturedRuntimePool.activate(capturedView === "chat" ? capturedTransport : undefined); }, () => [runtimePool(), transport(), view()]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    const capturedTransport = transport();
    await waitForConversationReady(capturedTransport, transport, connected, error);

    const ownerTransport = capturedTransport;
    const imagePayload = images.length ? { images } : {};

    if (splitPaneCommand(text)) commandImages.set(capturedTransport, images);

    try {
      if (behavior) return promptWasAccepted(await submitDraftPrompt(ownerTransport, { type: behavior === "steer" ? "steer" : "follow_up", message: text, ...imagePayload }));

      return promptWasAccepted(await submitDraftPrompt(capturedTransport, { type: "prompt", message: text, ...imagePayload }));
    } catch (reason) {
      if (isDaemonRefusal(reason)) addNotice({ title: "Could not send message", message: (reason as Error).message });
      throw reason;
    }
  };

  const respondToSplitRequest = (requestId: string, response: { value?: string; cancelled?: boolean }) => {
    const pending = pendingSplitRequest.current;

    if (!pending || pending.id !== requestId) return;
    pendingSplitRequest.current = undefined;
    void pending.transport.command({ type: "extension_ui_response", id: requestId, ...response }).catch((reason) => addNotice({ title: `Could not finish ${pending.command} request`, message: reason instanceof Error ? reason.message : String(reason) }));
  };

  const closeSplitPane = () => { if (splitPane()?.request) respondToSplitRequest(required(required((splitPane())).request).requestId, { cancelled: true }); setSplitPane(undefined); setSubagentPane(undefined); setActivePane("main"); };

  const openSubagent = (target: SubagentTarget) => { closeSplitPane(); setSubagentPane(target); setActivePane("split"); };

  const canLeaveSettings = () => view() !== "settings" || !settingsDirty() || window.confirm("Discard unsaved settings changes?");
  const activateTransport = createTransportActivation({ savedSessions: sessions, transport, transportConversationKeys, transportHasDraft, conversationTerminalIds, runtimePool, chatSession, composerDrafts, activeTransportRef, setTransport, discardDraft: drafts.discard, forgetTerminals: terminals.forgetConversation });
  useWorkspaceDisconnect(() => settingsDirty() || drafts.draftSummaries().length > 0 || drafts.submissions().length > 0, runtimePool, terminals.draftTerminalIds, () => activeTransportRef.current);

  /** "rename" moves the draft and terminals to the new key; "branch" leaves them with the original conversation. */
  const rekeyConversationUi = (previousKey: string, nextKey: string, ownerTransport: NativeTransport, mode: "rename" | "branch" = "rename") => {
    if (previousKey === nextKey) return;
    transportConversationKeys.current.set(ownerTransport, nextKey);

    if (mode === "rename") drafts.rekeyDraft(previousKey, nextKey);
    drafts.bindTransport(ownerTransport, nextKey);

    if (mode === "rename") terminals.rekeyConversation(previousKey, nextKey, ownerTransport);

    if (ownerTransport === activeTransportRef.current) activateConversationKey(nextKey);
  };

  const branchConversation = createMemo(() => (createBranchConversation({ transport: transport(), activeConversationKeyRef, branchPending, state: chatSession().state, sessions: sessions(), runtimePool: runtimePool(), messages: chatSession().messages, rekeyConversationUi, activeTransportRef, setActiveCwd, setState: chatSession().setState, setMessages: chatSession().setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, addNotice, syncSessionIndex, requestComposerFocus: () => setMainComposerFocusRequest(request => request + 1) })));

  const [revealEntry, setRevealEntry] = createSignal<{ key: string; entryId: string }>();
  const forkSourceSession = (source: ForkSource, hostId = activeHostId()) => sessions().find(session => session.id === source.sessionId && (session.hostId ?? "local") === hostId);
  const forkSourceName = createMemo(() => { const source = chatSession().state.forkSource;

    return source ? forkSourceSession(source)?.name : undefined; });

  const openForkSource = (source: ForkSource, hostId = activeHostId()) => {
    const session = forkSourceSession(source, hostId);

    if (!session) { addNotice({ title: "Could not open the original conversation", message: "It is archived or deleted." }); return; }
    setRevealEntry({ key: (session.hostId ?? "local") + ":" + session.id, entryId: source.entryId });
    selectSession(session);
  };

  const revealEntryId = createMemo(() => { const entry = revealEntry();

    return entry && entry.key === activeConversationKey() ? entry.entryId : undefined; });
  const entryRevealed = () => setRevealEntry(undefined);

  const branch = async (message: ChatMessage, mode: "branch" | "fork" = "branch") => {
    const capturedBranchConversation = branchConversation();

    try { await capturedBranchConversation(message, mode); } catch (reason) { addNotice({ title: "Could not fork conversation", message: reason instanceof Error ? reason.message : String(reason) }); } };

  const conversationBusy = () => chatSession().state.isStreaming || chatSession().state.isPausing || chatSession().state.pendingMessageCount;

  const forkAndForget = async (message: ChatMessage) => {
    const owner = transport();
    const sourcePath = owner.currentSessionPath();
    const hostId = owner.currentHostId();
    const source = sessions().find(item => item.path === sourcePath && (item.hostId ?? "local") === hostId);
    const pendingKey = `${activeConversationKeyRef.current}:forget`;

    if (branchPending.current.has(pendingKey)) return;
    branchPending.current.add(pendingKey);

    try {
      if (!source) throw new Error("Could not find the original saved conversation");

      if (conversationBusy()) throw new Error("Wait for the current response and queued messages to finish first");

      if (!await branchConversation()(message, "copy")) return;
      await archives.archiveSession(source);
      await syncSessionIndex();
    } catch (reason) {
      addNotice({ title: "Could not copy and archive conversation", message: reason instanceof Error ? reason.message : String(reason) });
    } finally { branchPending.current.delete(pendingKey); }
  };

  const canStartNewSession = () => !newSessionPending.current && canLeaveSettings();
  const newSessionTarget = (clearProject: boolean, group?: SessionGroup) => ({ hostId: group ? group.hostId ?? "local" : activeHostIdRef.current, projectCwd: group ? group.cwd ?? undefined : clearProject ? undefined : selectedProjectCwd(activeCwd(), transport().isTemporaryChat()) });

  const createSessionTransport = (cwd: string | undefined, hostId: string) => { const owner = runtimePool().create(cwd ? { cwd, hostId } : { hostId });

    return owner; };

  const prepareNewSession = (owner: NativeTransport, hostId: string, cwd?: string) => cwd ? owner.validateProjectDirectory(cwd, hostId, true, true) : owner.prepareTemporaryChat(hostId);
  const assignNewSessionGroup = (owner: NativeTransport, group?: SessionGroup) => { if (group) pendingSessionGroups.current.set(owner, group); };

  /** The unsent new chat that New conversation reopens: the newest one, on the current host first. */
  const existingSessionDraft = () => {
    const onHost = (draft: SessionSummary) => (draft.hostId ?? "local") === activeHostId() ? 0 : 1;
    const candidates = [...draftSessions()].sort((left, right) => onHost(left) - onHost(right) || (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));

    return candidates.find(draft => draft.isDraft && (!isSelectedSession(draft) || currentSessionIsDraft()) && !runningSessions().has(`${draft.hostId ?? "local"}:${draft.id}`) && ![...sessions(), ...liveSessions()].some(saved => saved.messageCount > 0 && (saved.hostId ?? "local") === (draft.hostId ?? "local") && (saved.id === draft.id || Boolean(draft.path && saved.path === draft.path))));
  };

  const currentSessionIsDraft = () => !chatSubmission(transport()) && !currentSessionHasSavedMessages() && !chatSession().state.isStreaming && chatSession().state.pendingMessageCount === 0 && chatSession().state.messageCount === 0 && chatSession().messages.length === 0;

  const reuseSessionDraft = () => {
    const draft = existingSessionDraft();

    if (!draft) return false;

    if (!isSelectedSession(draft)) selectSession(draft);

    setView("chat"); closeSplitPane();

    return true;
  };

  const closeMobileSidebar = () => { if (window.matchMedia("(max-width: 700px)").matches) setPanelOpen(false); };

  const reusableDraftSource = () => {
    const draft = existingSessionDraft();

    if (draft) return { owner: isSelectedSession(draft) ? transport() : runtimePool().forSession(draft), key: `${draft.hostId ?? "local"}:${draft.id}` };

    return currentSessionIsDraft() ? { owner: transport(), key: activeConversationKey() } : undefined;
  };

  const newDraftKey = (hostId: string, previous?: string) => `${hostId}:${previous ? previous.slice(previous.indexOf(":") + 1) : `draft-${crypto.randomUUID()}`}`;

/** fresh: forget the draft being reused, its text, attachments and chosen settings, so the new chat starts with the defaults. */
  const createNewSessionDraft = async (clearProject: boolean, group?: SessionGroup, project?: { cwd: string; hostId: string }, host?: string, fresh = false) => {
    closeMobileSidebar();
    setArchivesOpen(false);
    const ownerTransport = transport(); const ownerKey = activeConversationKeyRef.current;
    const request = projectOpenRequest.current;
    const isCurrent = () => (!project || projectOpenRef.current && projectOpenRequest.current === request) && activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey;
    const capturedSession = { ...chatSession() }; const pool = runtimePool();
    const target = project ? { hostId: project.hostId, projectCwd: project.cwd } : host ? { hostId: host, projectCwd: undefined } : newSessionTarget(clearProject, group);
    const { hostId } = target;
    let projectCwd = target.projectCwd;
    const source = reusableDraftSource();
    const conversationKey = newDraftKey(hostId, fresh ? undefined : source?.key);
    let nextTransport: NativeTransport | undefined;
    let activated = false;

    const releaseUnusedTransport = () => {
      if (activated || !nextTransport) return;
      transportConversationKeys.current.delete(nextTransport); pendingSessionGroups.current.delete(nextTransport);
      void pool.release(nextTransport).catch((reason) => addNotice({ title: "Could not clean up the new conversation", message: reason instanceof Error ? reason.message : String(reason) }));
    };

    try {
      const owner = createSessionTransport(projectCwd, hostId);
      nextTransport = owner;
      let cwd = await prepareNewSession(owner, hostId, projectCwd);
      if (projectCwd && cwd) {
        const branches = await owner.newChatBranches(cwd, hostId);
        if (!isCurrent()) return;
        if (branches) {
          cwd = await owner.validateProjectDirectory(branches.repository, hostId, true, true);
          owner.adoptBranchCwd(cwd);
          owner.setNewChatWorktreeOptions(branches);
        }
      }

      if (!isCurrent()) return;
      transportConversationKeys.current.set(nextTransport, conversationKey);

      if (source && fresh) drafts.discard(source.owner, source.key);
      else if (source) drafts.rekeyDraft(source.key, conversationKey);
      drafts.bindTransport(nextTransport, conversationKey);
      assignNewSessionGroup(nextTransport, group);
      batch(() => {
        setView("chat"); closeSplitPane(); setTerminalOpen(false); setTerminalTarget(undefined);
        updateConnected(false); setDefinedAgents(undefined); capturedSession.discardPendingUpdates();
        setActiveCwd(cwd); setActiveHostId(hostId); activateTransport(owner); activateConversationKey(conversationKey);
      });
      activated = true;

      if (source) {
        pendingSessionGroups.current.delete(source.owner);
        await pool.release(source.owner); transportConversationKeys.current.delete(source.owner);
      }

      return true;
    } catch (reason) {
      if (isCurrent()) {
        addNotice({ title: "Could not start a new conversation", message: reason instanceof Error ? reason.message : String(reason) });
      }
    } finally {
      releaseUnusedTransport();
    }
  };

  const currentSessionHasSavedMessages = () => sessions().some(session => session.messageCount > 0 && (session.hostId ?? "local") === activeHostId() && session.path === transport().currentSessionPath());

  const startNewSession = async (clearProject = false, group?: SessionGroup, project?: { cwd: string; hostId: string }, host?: string, fresh = false) => {
    if (!canStartNewSession()) return;
    newSessionPending.current = true;

    try {
      closeMobileSidebar(); setArchivesOpen(false);

      return await createNewSessionDraft(clearProject, group, project, host, fresh);
    } catch (reason) { addNotice({ title: "Could not open the draft", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { newSessionPending.current = false; setMainComposerFocusRequest(request => request + 1); }
  };

  // New conversation while a new draft is already open starts over: the draft is forgotten and the defaults come back.
  /** Resets only what differs from the defaults in the open draft. A project needs a new chat; text, attachments, agent and prompt settings reset in place. */
  const resetDraftInPlace = async () => {
    const owner = transport(); const key = activeConversationKey(); const agents = definedAgents();
    if (!owner.isTemporaryChat() || !agents) return false;
    const defaultAgent = agents.config.agents.find(agent => agent.isDefault)?.name;
    if (transportHasDraft(owner, key)) drafts.discard(owner, key);
    if (defaultAgent && agents.active !== defaultAgent) await setAgent(defaultAgent);
    else if (!owner.promptControls.untouched()) owner.promptControls.reset();
    return true;
  };
  /** The open new chat has nothing to start over: no text, attachments, project, chosen agent or chosen prompt settings. */
  const openDraftUntouched = () => {
    const owner = transport(); const agents = definedAgents();

    return !projectCwd() && !transportHasDraft(owner, activeConversationKey()) && owner.promptControls.untouched() && agents?.active === agents?.config.agents.find(agent => agent.isDefault)?.name;
  };
  const newSession = async () => {
    const fresh = currentSessionIsDraft(); setNewChatRequest(value => value + 1);
    // From an untouched new chat, New conversation reopens the newest unsent chat, which is not listed anywhere else.
    const unsent = existingSessionDraft();
    if (fresh && unsent && !isSelectedSession(unsent) && openDraftUntouched()) { await startNewSession(); return; }
    if (fresh && await resetDraftInPlace()) { closeMobileSidebar(); setArchivesOpen(false); setView("chat"); closeSplitPane(); setMainComposerFocusRequest(request => request + 1); return; }
    await startNewSession(fresh, undefined, undefined, undefined, fresh);
  };

  const clearChatProject = () => startNewSession(true);
  /** Projects belong to one host, so a new host starts a draft without a project. */
  const chooseChatHost = (hostId: string) => hostId === activeHostId() ? undefined : startNewSession(true, undefined, undefined, hostId);
  const isSplitSession = (session: SessionSummary) => splitPane()?.session.id === session.id && (required((splitPane())).session.hostId ?? "local") === (session.hostId ?? "local");
  const isSelectedSession = (session: SessionSummary) => (session.hostId ?? "local") === activeHostId() && (session.id === chatSession().state.sessionId || `${session.hostId ?? "local"}:${session.id}` === activeConversationKey());
  const closeSplitForSession = (session: SessionSummary) => { if (isSplitSession(session) || splitPane()?.request) closeSplitPane(); };

  const selectSession = (session: SessionSummary) => {
    if (archives.isPending(session) || !canLeaveSettings()) return undefined;
    setArchivesOpen(false);

    if (window.matchMedia("(max-width: 700px)").matches) setPanelOpen(false);

    if (session.cwdExists === false) { void openDirlessSession(session, "select");

      return undefined; }

    const hostId = session.hostId ?? "local";

    if (isSelectedSession(session)) { if (!connected()) reconnectMain();

      return transport(); }

    closeSplitForSession(session);
    const nextTransport = runtimePool().forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); drafts.bindTransport(nextTransport, conversationKey); activateConversationKey(conversationKey); chatSession().discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd || undefined); activateTransport(nextTransport);

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

    try { await capturedTransport.command({ type: "select_agent", agent: name }); capturedTransport.promptControls.reset(); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };

  const openProject = async (cwd: string, hostId: string) => {
    if (await startNewSession(false, undefined, { cwd, hostId })) { projectOpenRef.current = false; setProjectOpen(false); }
  };

  const chooseChatProject = () => { projectOpenRequest.current += 1; setProjectOpen(true); };

  const openSplitPane = (session: SessionSummary) => { const owner = runtimePool().forSession(session); transportConversationKeys.current.set(owner, `${session.hostId ?? "local"}:${session.id}`); drafts.bindTransport(owner, `${session.hostId ?? "local"}:${session.id}`); closeSplitPane(); setSplitPane({ key: crypto.randomUUID(), session }); };

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
    removeConversationTerminals: terminals.removeConversationTerminals, removeDraft: drafts.removeDraft, removeSessionDrafts: drafts.removeSessionDrafts,
    setSessions, setActiveCwd, activateTransport, activateConversationKey, updateConnected,
    closeSplitPane, syncSessionIndex, addNotice, reuseSessionDraft, archiveCount,
  });

  const archiveSession = archives.archiveSession;

  const openSessionInWindow = async (session: SessionSummary) => { if (isMobile) { selectSession(session);

      return; }

    try { await openSessionWindow({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id, hostId: session.hostId }); } catch (reason) { addNotice({ title: "Could not open window", message: reason instanceof Error ? reason.message : String(reason) }); } };

  const sessionAction = async (session: SessionSummary, action: SessionAction) => archives.isPending(session) || (session.isDraft && action !== "open-directory") ? undefined : performSessionAction(session, action);

  const performSessionAction = async (session: SessionSummary, action: SessionAction) => { const capturedRuntimePool = runtimePool();

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

  };

  const draftChangeFor = (sessionKey: string, owner?: NativeTransport) => (update: StateUpdate<string>) => owner ? drafts.setTransportDraft(owner, update) : setComposerDraft(sessionKey, update);
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

  useAppKeyboard({ settings, activePane, splitPane, canLeaveSettings, setView, panelOpen, setPanelOpen, newSession, toggleTerminal, toggleDebugMode, setSplitComposerFocusRequest, setMainComposerFocusRequest, settingsDirty, view, terminalOpen, setTerminalOpen });
  const extensionStateIsCurrent = createMemo(() => (extensionOwner() === transport()));
  const activeDialog = createMemo(() => dialogs()[0]);
  const projectCwd = createMemo(() => (selectedProjectCwd(activeCwd(), transport().isTemporaryChat())));
  const mobileSidebarOpen = () => panelOpen() && view() === "chat";

  const sidebar = createSidebarState(() => {
    const summaries = new Map([...liveSessions(), ...draftSessions(), ...sessions()].map(session => [`${session.hostId ?? "local"}:${session.id}`, session]));

    // A new chat joins the list when its first message is sent. The New chat button reopens an unsent one.
    return [...summaries.values()].filter(session => !archives.isArchived(session) && !session.isDraft);
  }, query);

  const chatAgentProps = () => { if (!extensionStateIsCurrent()) return { agents: [], activeAgent: undefined, agentLocked: false, agentSaved: false, agentUnavailable: false };

    return { agents: (definedAgents()?.config.agents ?? []), activeAgent: definedAgents()?.active, agentLocked: definedAgents()?.locked, agentSaved: definedAgents()?.saved, agentUnavailable: definedAgents()?.unavailable }; };

  const chatModels = createMemo(() => modelVisibility.visibleModels(activeHostId(), chatSession().models));

  /** While a chat loads, the composer keeps the values it shows, so that only the values that differ change when the chat is ready. */
  const heldWhileLoading = <T,>(ready: () => boolean, live: () => T) => {
    let last: { value: T } | undefined;

    return createMemo(() => { const value = live(); if (ready() || !last) last = { value }; return last.value; });
  };
  const fastStatusKey = "pi-desktop-fast-mode";
  const liveComposerState = () => composerControls.state(chatSession().state);
  const heldPrompt = heldWhileLoading(connected, () => { const state = liveComposerState(); return { model: state.model, thinkingLevel: state.thinkingLevel, contextUsage: state.contextUsage }; });
  const heldFastStatus = heldWhileLoading(connected, () => composerControls.statuses(extensionStateIsCurrent() ? statuses() : {}, liveComposerState().model)[fastStatusKey] as string | undefined);
  const composerView = {
    state: createMemo(() => { const state = liveComposerState(); const held = heldPrompt(); return connected() ? state : { ...state, ...held }; }),
    agentProps: heldWhileLoading(() => connected() && extensionStateIsCurrent(), chatAgentProps),
    models: heldWhileLoading(connected, chatModels),
    thinkingLevels: heldWhileLoading(connected, () => composerControls.thinkingLevels(chatSession().thinkingLevels)),
    statuses: createMemo(() => { const { [fastStatusKey]: _fast, ...rest } = composerControls.statuses(extensionStateIsCurrent() ? statuses() : {}, liveComposerState().model); const fast = heldFastStatus(); return fast === undefined ? rest : { ...rest, [fastStatusKey]: fast }; }),
  };
  const chatCommands = createMemo<SlashCommand[]>(() => chatSession().commands);
  const chatWidgets = createMemo(() => extensionStateIsCurrent() ? Object.values(widgets()).flat() : []);
  const dirlessPending = new Set<string>();
  const [missingDirectoryDialog, setMissingDirectoryDialog] = createSignal<MissingDirectoryRequest>();

  const openDirlessSession = async (session: SessionSummary, action: SessionAction | "select") => {
    const hostId = session.hostId ?? "local"; const key = `${hostId}:${session.id}`;

    if (dirlessPending.has(key) || missingDirectoryDialog()) return; dirlessPending.add(key);
    const client = transport(); const pool = runtimePool();
    let relocated: SessionSummary | undefined;
    const cancel = () => { dirlessPending.delete(key); setMissingDirectoryDialog(undefined); };

    setMissingDirectoryDialog({ session, cancel, recover: async () => {
        if (!relocated) {
          const result = await client.recoverMissingSession(session.path, hostId);

          relocated = { ...session, cwd: result.cwd, cwdExists: true };
        }

        const recovered = relocated;
        setSessions(current => current.map(item => item.id === session.id && (item.hostId ?? "local") === hostId ? recovered : item));
        const owner = client.currentSessionPath() === session.path && client.currentHostId() === hostId ? client : pool.forSession(session);
        pool.bind(hostId, session.id, owner); pool.setLiveSession(owner, relocated);
        await owner.restoreConnection({ cwd: relocated.cwd, sessionPath: session.path, hostId });
        cancel();

        if (action === "select") selectSession(relocated); else await sessionAction(relocated, action);
        void syncSessionIndex();
      } });
  };

 return { modelVisibility, drafts, archiveReplacedSession: (session: SessionSummary) => archives.archiveSession(session), isArchiving: archives.isPending, missingDirectoryDialog, archivesOpen, setArchivesOpen, runtimePool, transport, view, setView, activeConversationKey, chatViewKey, runningSessions, unseenSessions, pendingSettingsCount, chatSession, sessions, settings, settingsSaving, debugModeSaving, setSettingsDirty, panelOpen, setPanelOpen, query, setQuery, connected, error, setError, createGroupRequest, setCreateGroupRequest, handleCreateGroup, newChatRequest, activeHostId, codexUsage, usageClock, opencodeGoBadge, codexUsageError, opencodeGoUsageError, setDialogs, notices, setNotices, addNotice, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, releaseSplitTransport, statuses, widgets, renameSession, setRenameSession, projectOpen, setProjectOpen, projectOpenRef, uploadsByTransport, setComposerDraft, setComposerUploads, splitPane, setSplitPane, subagentPane, hasSidePane, mainComposerFocusRequest, splitComposerFocusRequest, activePane, setActivePane, terminals, terminalOpen, terminalSessionId, terminalLocationState, startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal, reconnectPending, splitSessionId, composerState, terminalViewKey, syncSessionIndex, composerControls, resolveHomeDirectory, send, respondToSplitRequest, closeSplitPane, openSubagent, canLeaveSettings, rekeyConversationUi, branch, forkAndForget, forkSourceName, openForkSource, revealEntryId, entryRevealed, startNewSession, newSession, clearChatProject, chooseChatHost, selectSession, setModel, setThinking, abortInteraction, pauseInteraction, resumeInteraction, saveSettings, setAgent, openProject, chooseChatProject, sessionAction, draftChangeFor, uploadsChangeFor, toggleComposerTerminal, toggleDebugMode, toggleDebugFeature, reconnectMain, extensionStateIsCurrent, activeDialog, projectCwd, mobileSidebarOpen, sidebar, chatAgentProps, chatModels, chatCommands, chatWidgets, composerView };

}
