import { batch, createComputed, createMemo, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import { createAppExtensions } from "./appExtensions";
import { createAppSettings } from "./appSettings";
import { createAppTerminals } from "./appTerminals";
import { createTransportActivation } from "./appTransportActivation";
import { createWorktreeActions } from "./appWorktrees";
import { configureConversationRuntime } from "./appRuntime";
import { selectedProjectCwd, splitConversationKey, type RenameTarget, type SplitPaneState, type WorktreeTarget } from "./appSupport";
import { createBranchConversation } from "./branchConversation";
import type { SessionAction } from "./components/SessionPanel";
import { encodeAgentValue } from "./lib/agentProtocol";
import { hasVisibleText } from "./lib/content";
import { branchMessages, type PiEntry } from "./lib/messages";
import { initialWindowTarget, NativeTransport, openSessionWindow } from "./lib/nativeTransport";
import { isMobile, listen } from "./lib/platform";
import { updateSessionGroups, type SessionGroup } from "./lib/sessionGroups";
import { SessionRuntimePool, useTurnDiffs } from "./lib/sessionRuntimePool";
import { createDependencyEffect, createMemoFields, createRef, createSubscription, type StateUpdate } from "./lib/solid";
import type { SubagentTarget } from "./lib/subagentNavigation";
import { useChatSession } from "./lib/useChatSession";
import type { AgentState, AppSettings, ChatMessage, ComposerUpload, ImageAttachment, Model, SessionSummary, SlashCommand } from "./types";
import { useAppEvents } from "./useAppEvents";

type ConversationContext = {
  view: Accessor<"chat" | "settings">;
  setView: Setter<"chat" | "settings">;
  setPanelOpen: Setter<boolean>;
  addNotice: (notice: { title: string; message: string }) => void;
};

export function createAppConversations({ view, setView, setPanelOpen, addNotice }: ConversationContext) {
  const runtimePool = createMemo(() => new SessionRuntimePool()); const [transport, setTransport] = createSignal((() => { const initial = runtimePool().create(initialWindowTarget()); runtimePool().activate(initial); return initial; })());
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
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const sessionIndexRequest = createRef<Promise<void> | undefined>(undefined);
  const [connected, setConnected] = createSignal(false); const connectionReadyRef = createRef(connected()); createComputed(() => { connectionReadyRef.current = connected(); }); const updateConnected = (value: boolean) => { const owned = value && activeTransportRef.current.ownsConversation(); connectionReadyRef.current = owned; setConnected(owned); }; const [error, setError] = createSignal<string>();
  const [activeHostId, setActiveHostId] = createSignal((() => transport().currentHostId())());
  const [activeCwd, setActiveCwd] = createSignal<string | undefined>((() => transport().currentCwd())());
  const [isGitRepository, setIsGitRepository] = createSignal<boolean>();
  const activeHostIdRef = createRef(activeHostId()); createComputed(() => { activeHostIdRef.current = activeHostId(); });
  const settingsController = createAppSettings({ transport, runtimePool, availableModels: () => chatSession().models, addNotice });
  const { settings } = settingsController;
  const hasRetainedDraft = (ownerTransport: NativeTransport) => {
    const key = transportConversationKeys.current.get(ownerTransport);
    return Boolean(key && composerDrafts()[key]) || runtimePool().liveSessionSummaries().some(session => session.isDraft && `${session.hostId ?? "local"}:${session.id}` === key);
  };
  const releaseSplitTransport = async (ownerTransport: NativeTransport) => { const capturedRuntimePool = runtimePool();
    if (activeTransportRef.current === ownerTransport) return;
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
  const [relocatingSession, setRelocatingSession] = createSignal<SessionSummary>(); const [relocationError, setRelocationError] = createSignal<string>();
  const relocationActionRef = createRef<"select" | "split" | "rename">("select");
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
  const controlQueues = createRef(new WeakMap<NativeTransport, Promise<void>>());
  const reconnectPending = createRef(new Set<NativeTransport>());
  const splitSessionId = createMemo(() => (splitConversationKey(splitPane())));
  onCleanup(() => {
    void runtimePool().disconnectAll();
  });
  const terminals = createAppTerminals({
    transport,
    conversation: () => ({
      sessionKey: activeConversationKey(),
      cwd: activeCwd() ?? sessions().find(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.cwd,
      hostId: activeHostId(),
    }),
    addNotice,
  });
  const { terminalSessionId } = terminals;
  const composerValues = () => {
    const composerDraft = composerDrafts()[activeConversationKey()] ?? "";
    const composerUploads = uploadsByTransport().get(transport()) ?? [];
    const splitComposerDraft = composerDrafts()[splitSessionId()] ?? "";
    return { composerDraft, composerUploads, splitComposerDraft };
  };
  const composerFields = createMemoFields(composerValues);
  const composerState = () => composerFields;
  const activateConversationKey = (key: string) => { activeConversationKeyRef.current = key; setActiveConversationKey(key); };
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool();
 capturedRuntimePool.setErrorHandler((message) => addNotice({ title: message.startsWith("Could not load saved project changes") || message.startsWith("Could not save project changes") ? "Project changes" : "Session", message })); return () => { capturedRuntimePool.setErrorHandler(); }; }, () => [addNotice, runtimePool()]);
  createDependencyEffect(() => { const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId(); const capturedTransport = transport();
    const previousKey = activeConversationKeyRef.current;
    if (!capturedSession.state.sessionId || !previousKey.includes(":draft-")) return;
    const canonicalKey = `${capturedActiveHostId}:${capturedSession.state.sessionId}`;
    if (previousKey === canonicalKey) return;
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [canonicalKey]: current[previousKey] }; delete next[previousKey]; return next; });
    terminals.rekeyStored(previousKey, canonicalKey);
    transportConversationKeys.current.set(capturedTransport, canonicalKey); activateConversationKey(canonicalKey);
  }, () => [activeHostId(), chatSession().state.sessionId, transport()]);
  createDependencyEffect(() => { const capturedTransport = transport();
    let cancelled = false;
    setIsGitRepository(undefined);
    void capturedTransport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, () => [transport(), sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId())?.projectKind]);
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
  const refresh = async (hostId?: string) => { const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool();
    void syncSessionIndex();
    const settingsRequest = settingsController.load(capturedTransport);
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
  const configureRuntime = (value: AppSettings) => configureConversationRuntime(value, transport(), () => activeTransportRef.current, projectControls);
  const resolveHomeDirectory = (hostId: string) => transport().homeDirectory(hostId);
  const extensions = createAppExtensions({
    transport, session: chatSession, addNotice,
    isCurrent: owner => activeTransportRef.current === owner,
    openBtw: pane => setSplitPane({ ...pane, session: { ...pane.session, hostId: activeHostIdRef.current } }),
    setEditorText: (owner, text) => {
      const key = transportConversationKeys.current.get(owner) ?? terminalSessionId();
      if (typeof text === "string") setComposerDrafts(current => ({ ...current, [key]: text }));
      setActivePane("main"); setMainComposerFocusRequest(value => value + 1);
    },
  });
  const { definedAgents, closeTransportDialogs, respondToBtw } = extensions;
  useAppEvents(() => { const owner = transport(); return {
    transport: owner, isCurrent: () => activeTransportRef.current === owner,
    handleEvent: chatSession().handleEvent, refresh, refreshSession: chatSession().refresh, configureRuntime,
    extensions, terminals, connected: updateConnected, failed: setError,
    hostChanged: () => {
      if (owner.currentHostId() === activeHostIdRef.current) return;
      const key = `local:draft-${crypto.randomUUID()}`;
      setActiveHostId(owner.currentHostId()); setActiveCwd(owner.currentCwd());
      transportConversationKeys.current.set(owner, key); activateConversationKey(key); terminals.reset();
    },
  }; });
  createDependencyEffect(() => {
    const capturedRuntimePool = runtimePool();
 const shutdown = () => { void capturedRuntimePool.disconnectAll(); }; window.addEventListener("pagehide", shutdown); return () => window.removeEventListener("pagehide", shutdown); }, () => [runtimePool(), transport()]);
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
    const ownerTransport = capturedTransport;
    const imagePayload = images.length ? { images } : {};
    if (/^\/btw(?:\s|$)/.test(text.trim())) extensions.retainBtwImages(capturedTransport, images);
    const branchCommand = /^\/(worktree|branch-off)(?:\s+(.*))?$/s.exec(text.trim());
    if (branchCommand) {
      return sendBranchCommand(branchCommand, images);
    }
    try {
    if (behavior) { await ownerTransport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...imagePayload }); return; }
    await capturedTransport.command({ type: "prompt", message: text, ...imagePayload });
    return true;
    } catch (reason) { addNotice({ title: "Could not send message", message: reason instanceof Error ? reason.message : String(reason) }); throw reason; }
  };
  const closeSplitPane = () => { if (splitPane()?.btw) respondToBtw((splitPane())!.btw!.requestId, { cancelled: true }); setSplitPane(undefined); setSubagentPane(undefined); setActivePane("main"); };
  const openSubagent = (target: SubagentTarget) => { closeSplitPane(); setSubagentPane(target); setActivePane("split"); };
  const canLeaveSettings = () => settingsController.canLeave(view());
  const setComposerUploads = (ownerTransport: NativeTransport, update: StateUpdate<ComposerUpload[]>) => setUploadsByTransport((current) => {
    const next = new Map(current);
    const uploads = typeof update === "function" ? update(next.get(ownerTransport) ?? []) : update;
    if (uploads.length) next.set(ownerTransport, uploads); else next.delete(ownerTransport);
    return next;
  });
  const transportHasDraft = (owner: NativeTransport, key?: string) => Boolean(key && composerDrafts()[key]) || (uploadsByTransport().get(owner)?.length ?? 0) > 0;
  const conversationTerminalIds = terminals.ids;
  const activateTransport = createTransportActivation({ transport, transportConversationKeys, transportHasDraft, conversationTerminalIds, runtimePool, chatSession, composerDrafts, activeTransportRef, setTransport, setUploadsByTransport, setComposerDrafts, forgetTerminals: terminals.forget });
  const rekeyConversationUi = (previousKey: string, nextKey: string, ownerTransport: NativeTransport, moveTerminals = true, copyDraft = false) => {
    if (previousKey === nextKey) return;
    if (moveTerminals) terminals.rekey(previousKey, nextKey, ownerTransport);
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; if (!copyDraft) delete next[previousKey]; return next; });
    transportConversationKeys.current.set(ownerTransport, nextKey);
    if (ownerTransport === activeTransportRef.current) activateConversationKey(nextKey);
  };
  const branchConversation = createMemo(() => (createBranchConversation({ transport: transport(), activeConversationKeyRef, branchPending, state: chatSession().state, sessions: sessions(), runtimePool: runtimePool(), messages: chatSession().messages, rekeyConversationUi, activeTransportRef, setActiveCwd, resetTerminal: terminals.reset, setState: chatSession().setState, setMessages: chatSession().setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, addNotice, syncSessionIndex })));
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
  const confirmNewSession = (clearProject: boolean) => clearProject || !(hasVisibleText(composerState().composerDraft) || composerState().composerUploads.length) || window.confirm("Start a new conversation and discard the unsent draft?");
  const canStartNewSession = (clearProject: boolean) => !newSessionPending.current && canLeaveSettings() && confirmNewSession(clearProject);
  const newSessionTarget = (clearProject: boolean, group?: SessionGroup) => ({ hostId: group ? group.hostId ?? "local" : activeHostIdRef.current, projectCwd: group ? group.cwd ?? undefined : clearProject ? undefined : selectedProjectCwd(activeCwd(), transport().isTemporaryChat()) });
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
        setView("chat"); closeSplitPane(); terminals.reset();
        updateConnected(false); extensions.clearAgents(); capturedSession.discardPendingUpdates();
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
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); chatSession().discardPendingUpdates(); setView("chat"); terminals.hide(); updateConnected(false); extensions.clearAgents(); setActiveHostId(hostId); setActiveCwd(session.cwd); activateTransport(nextTransport); return nextTransport;
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
  const setAgent = async (name: string) => {
    const capturedTransport = transport();
 try { await capturedTransport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const openProject = async (cwd: string, hostId: string) => {
    const capturedTransport = transport(); const capturedSession = { ...chatSession() }; const capturedRuntimePool = runtimePool(); const capturedComposerState = { ...composerState() };
 if (!canLeaveSettings()) return; const controls = { agent: definedAgents()?.active, model: capturedSession.state.model, thinking: capturedSession.state.thinkingLevel }; const request = projectOpenRequest.current; const validatedCwd = await capturedTransport.validateProjectDirectory(cwd, hostId); if (!projectOpenRef.current || request !== projectOpenRequest.current) return; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); terminals.hide(); updateConnected(false); extensions.clearAgents(); capturedSession.discardPendingUpdates(); activateConversationKey(conversationKey); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = capturedRuntimePool.create({ cwd: validatedCwd, hostId }); projectControls.set(nextTransport, controls); transportConversationKeys.current.set(nextTransport, conversationKey); setComposerDraft(conversationKey, capturedComposerState.composerDraft); setComposerUploads(nextTransport, capturedComposerState.composerUploads); activateTransport(nextTransport); };
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
      terminals.forget(archivedSessionKey);
      if (archivedSessionKey === terminalSessionId()) terminals.hide();
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
    const hostId = session.hostId ?? "local";
    const sourcePath = session.path; const previousKey = `${hostId}:${session.id}`; try { await selectedTransport.connect(); const sourceDiffs = await capturedRuntimePool.captureMemoryDiffs(selectedTransport); const cloned = await selectedTransport.command<{ cancelled?: boolean }>({ type: "clone" }); if (cloned.cancelled) return; const nextState = await selectedTransport.command<AgentState>({ type: "get_state" }); capturedRuntimePool.bind(hostId, nextState.sessionId, selectedTransport); rekeyConversationUi(previousKey, `${hostId}:${nextState.sessionId}`, selectedTransport, true, true); if (!selectedTransport.isEphemeral()) { const sourceTransport = capturedRuntimePool.forSession(session); setUploadsByTransport((current) => { const next = new Map(current); next.set(sourceTransport, [...(current.get(selectedTransport) ?? [])]); return next; }); } const history = await selectedTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); const nextMessages = branchMessages(history.entries, history.leafId); if (activeTransportRef.current === selectedTransport) { capturedSession.setState(nextState); capturedSession.setMessages(nextMessages); updateConnected(true); } try { await capturedRuntimePool.copySavedDiffs(selectedTransport, sourcePath, nextState.sessionFile, new Set(nextMessages.map((entry) => entry.id)), sourceDiffs); } catch (reason) { addNotice({ title: "Conversation cloned, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); } await syncSessionIndex(); } catch (reason) { addNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
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
  const setComposerDraft = (sessionKey: string, update: StateUpdate<string>) => setComposerDrafts((current) => { const value = typeof update === "function" ? update(current[sessionKey] ?? "") : update; if (value) return { ...current, [sessionKey]: value }; const next = { ...current }; delete next[sessionKey]; return next; });
  const draftChangeFor = (sessionKey: string, owner?: NativeTransport) => (update: StateUpdate<string>) => setComposerDraft(owner ? transportConversationKeys.current.get(owner) ?? sessionKey : sessionKey, update);
  const uploadsChangeFor = (owner: NativeTransport) => (update: StateUpdate<ComposerUpload[]>) => setComposerUploads(owner, update);
  const toggleTerminal = () => { if (!canLeaveSettings()) return; setView("chat"); const split = activePane() === "split" ? splitPane()?.session : undefined; terminals.toggle(split ? { sessionKey: `${split.hostId ?? "local"}:${split.id}`, cwd: split.cwd, hostId: split.hostId ?? "local" } : { sessionKey: activeConversationKeyRef.current, cwd: selectedProjectCwd(activeCwd(), transport().isTemporaryChat()), hostId: activeHostIdRef.current }); };
  const reconnectMain = () => {
    const ownerTransport = transport(); const ownerKey = activeConversationKeyRef.current;
    if (reconnectPending.current.has(ownerTransport)) return; reconnectPending.current.add(ownerTransport); setError(undefined); updateConnected(false);
    void ownerTransport.connect().then(() => ownerTransport.loadSettings()).then((value) => activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey ? configureRuntime(value) : undefined).then(async () => {
    const capturedSession = { ...chatSession() };
 if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await capturedSession.refresh(); }).then(() => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) { setError(undefined); updateConnected(true); void syncSessionIndex(); } }).catch((reason) => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { reconnectPending.current.delete(ownerTransport); });
  };
  const projectCwd = createMemo(() => (selectedProjectCwd(activeCwd(), transport().isTemporaryChat())));
  const chatModels = createMemo(() => chatSession().models.filter(model => !settings()?.hiddenModels.includes(`${model.provider}/${model.id}`)));
  const chatCommands = createMemo<SlashCommand[]>(() => [{ name: "branch-off", description: "Branch conversation [number back, default 0]", source: "builtin" }, { name: "worktree", description: "Create worktree [number back, default 0] [name]", source: "builtin" }, ...chatSession().commands.filter(command => !["branch-off", "worktree"].includes(command.name))]);
  const updateRelocatedGroup = async (session: SessionSummary, relocated: SessionSummary, hostId: string) => {
    const projectPath = relocated.projectRoot ?? relocated.cwd;
    try { await updateSessionGroups({ type: "relocate", key: `${hostId}:${session.id}`, project: { id: `${hostId}:${projectPath}`, name: projectPath.split("/").filter(Boolean).at(-1) ?? relocated.project, cwd: projectPath, hostId, hostName: relocated.hostName, projectKind: relocated.projectKind } }); }
    catch (reason) { addNotice({ title: "Project relocated, but its sidebar group could not be updated", message: String(reason) }); }
  };
  const relocateConversation = async (response: { value?: string; cancelled?: boolean }) => {
    const session = relocatingSession()!; const ownerTransport = transport(); const pool = runtimePool(); const action = relocationActionRef.current;
    if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; }
    const cwd = typeof response.value === "string" ? response.value : "";
    if (!hasVisibleText(cwd)) { setRelocationError("Path can't be empty"); return; }
    setRelocationError(undefined);
    try {
      await ownerTransport.relocateSession(session.path, cwd, session.hostId);
      const relocated = (await ownerTransport.listSessions()).find((item) => item.id === session.id && (item.hostId ?? "local") === (session.hostId ?? "local"));
      if (!relocated) throw new Error("The relocated conversation could not be found. Refresh the conversation list and retry.");
      const hostId = session.hostId ?? "local";
      await updateRelocatedGroup(session, relocated, hostId);
      setSessions((current) => current.map((item) => item.id === session.id && (item.hostId ?? "local") === hostId ? relocated : item));
      const owner = pool.forSession(session);
      pool.setLiveSession(owner, relocated);
      await owner.restoreConnection({ cwd: relocated.cwd, sessionPath: session.path, hostId });
      setRelocatingSession(undefined);
      if (action === "split") openSplitPane(relocated);
      else if (action === "rename") setRenameSession({ session: relocated, transport: owner });
      else selectSession(relocated);
    } catch (reason) { setRelocationError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const renameConversation = async (response: { value?: string; cancelled?: boolean }) => {
    const capturedRenameSession = renameSession(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId();
 if (response.cancelled) { setRenameSession(undefined); return; } if (typeof response.value !== "string" || !hasVisibleText(response.value)) throw new Error("Conversation name can't be empty"); const name = response.value.trim(); await (capturedRenameSession)!.transport.connect(); await (capturedRenameSession)!.transport.command({ type: "set_session_name", name }); if ((capturedRenameSession)!.session.id === capturedSession.state.sessionId && ((capturedRenameSession)!.session.hostId ?? "local") === capturedActiveHostId) capturedSession.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined);
  };
  const changeSplitSession = (paneKey: string, next: SessionSummary, owner: NativeTransport) => {
    const current = splitPane()?.key === paneKey ? splitPane() : undefined;
    if (!current) return;
    const previousKey = splitConversationKey(current);
    const nextKey = `${next.hostId ?? "local"}:${next.id}`;
    batch(() => {
      rekeyConversationUi(previousKey, nextKey, owner);
      setSplitPane(value => value?.key === paneKey ? { ...value, session: next } : value);
    });
  };
  const sidebarSessions = createMemo(() => [...sessions(), ...liveSessions().filter((live) => !archivedSessionKeys.current.has(`${live.hostId ?? "local"}:${live.id}`) && !sessions().some((saved) => saved.id === live.id && saved.hostId === live.hostId))]);
  const isReconnecting = () => reconnectPending.current.has(transport());
  const dismissError = () => setError(undefined);
  const cancelProject = () => { projectOpenRef.current = false; setProjectOpen(false); };
  const requestWorktree = (target: WorktreeTarget) => setWorktreeTarget(target);
  const cancelWorktree = () => setWorktreeTarget(undefined);
  const toggleFastMode = () => { const owner = transport(); return enqueueControl(owner, () => owner.toggleFastMode()); };
  const uploadsFor = (owner: NativeTransport) => uploadsByTransport().get(owner) ?? [];
  return {
    runtimePool, transport, settingsController, terminals, extensions,
    sessions, sidebarSessions, runningSessions, unseenSessions, pendingSettingsCount, gitDiffs, chatSession,
    activeConversationKey, activeHostId, activeCwd, connected, error, isGitRepository, projectCwd,
    splitPane, splitSessionId, subagentPane, hasSidePane, activePane, setActivePane,
    mainComposerFocusRequest, splitComposerFocusRequest, setMainComposerFocusRequest, setSplitComposerFocusRequest,
    composerState, draftChangeFor, uploadsChangeFor, uploadsFor, setComposerUploads, setComposerDraft,
    newSession, startNewSession, selectSession, sessionAction, clearChatProject, chooseChatProject,
    send, branch, forkAndForget, setAgent, setModel, setThinking, toggleFastMode,
    abortInteraction, pauseInteraction, resumeInteraction, reconnectMain, isReconnecting, dismissError,
    openSubagent, closeSplitPane, releaseSplitTransport, changeSplitSession,
    projectOpen, openProject, cancelProject, resolveHomeDirectory, canLeaveSettings, toggleTerminal,
    renameSession, renameConversation, relocatingSession, relocationError, relocateConversation,
    worktreeTarget, requestWorktree, cancelWorktree, createWorktree, deleteWorktree, chatModels, chatCommands
  };
}
