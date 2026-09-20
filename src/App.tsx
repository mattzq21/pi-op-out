import { createBranchConversation } from "./branchConversation";
import { type SessionTerminals, type QueuedTerminalOutput, type SplitPaneState, type OwnedExtensionDialog, type RenameTarget, type WorktreeTarget, type TerminalTarget, MAX_TERMINALS, initialTerminals, appendTerminalOutputs, selectedProjectCwd, formatCodexReset, usageWindowsDescription, normalizeOpencodeGoUsage, normalizeCodexUsage, LimitBadge, goUsageBadge, dialogOwnerName, splitConversationKey, terminalConversationKey, AppLoading, useUsageClock, definedAgentSettings } from "./appSupport";
import { useAppEvents } from "./useAppEvents";
export { formatCodexReset, usageWindowsDescription, normalizeOpencodeGoUsage, normalizeCodexUsage } from "./appSupport";
import { hasVisibleText, textOf } from "./lib/content";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { ArrowLeft, Bug, FolderPlus, GitBranch, MessageSquare, Server, Settings } from "lucide-react";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { FindInPage } from "./components/FindInPage";
import { ChatView } from "./components/ChatView";
import { IconButton } from "./components/IconButton";
import { SessionPanel, type SessionAction } from "./components/SessionPanel";
import { LocalSettingsView } from "./components/LocalSettingsView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { TerminalView } from "./components/TerminalView";
import { ProjectDialog } from "./components/ProjectDialog";
import { WorktreeDialog } from "./components/WorktreeDialog";
import { SplitChatPane } from "./components/SplitChatPane";
import { keybindDefinitions, matchesShortcut } from "./lib/keybindings";

import { updateSessionGroups, type SessionGroup } from "./lib/sessionGroups";
import { listen, isMobile } from "./lib/platform";
import { withClientSettings } from "./lib/clientSettings";
import { NativeTransport, initialWindowTarget, openSessionWindow } from "./lib/nativeTransport";
import { SessionRuntimePool, useTurnDiffs } from "./lib/sessionRuntimePool";
import { useChatSession } from "./lib/useChatSession";
import { encodeAgentValue } from "./lib/agentProtocol";
import { TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import type { AgentState, AppSettings, ChatMessage, CodexUsage, ComposerUpload, ExtensionUiRequest, ImageAttachment, Model, OpencodeGoUsage, DefinedAgentsCapability, AgentConfig, SettingsChange, SessionSummary } from "./types";
import { branchMessages, type PiEntry } from "./lib/messages";
import { recordSeenModels } from "./lib/modelVisibility";

declare const __PIOP_DEVELOPMENT_BRANCH__: string;

export default function App() {
  const runtimePool = useMemo(() => new SessionRuntimePool(), []); const [transport, setTransport] = useState(() => { const initial = runtimePool.create(initialWindowTarget()); runtimePool.activate(initial); return initial; }); const [view, setView] = useState<"chat" | "settings">("chat");
  const activeTransportRef = useRef(transport); activeTransportRef.current = transport;
  const pendingSessionGroups = useRef(new WeakMap<NativeTransport, string>());
  const initialConversationKey = useRef(`local:draft-${crypto.randomUUID()}`);
  const [activeConversationKey, setActiveConversationKey] = useState(initialConversationKey.current);
  const activeConversationKeyRef = useRef(activeConversationKey); activeConversationKeyRef.current = activeConversationKey;
  const transportConversationKeys = useRef(new Map<NativeTransport, string>([[transport, initialConversationKey.current]]));
  useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.liveSessionRevision());
  const runningSessions = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.runningSessions());
  const unseenSessions = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.unseenSessions());
  const pendingSettingsCount = useSyncExternalStore((listener) => runtimePool.subscribe(listener), () => runtimePool.pendingSettingsCount());
  const gitDiffs = useTurnDiffs(runtimePool, transport);
  const sessionRuntime = useChatSession(transport); const { state, setState, messages, setMessages, models, commands, thinkingLevels, refresh: refreshSession, handleEvent, discardPendingUpdates } = sessionRuntime;
  const [sessions, setSessions] = useState<SessionSummary[]>([]); const [settings, setSettings] = useState<AppSettings>();
  const runtimeSettings = useRef<AppSettings | undefined>(undefined);
  const applyRuntimeSettings = useCallback((next: AppSettings) => {
    const previous = runtimeSettings.current;
    runtimeSettings.current = next;
    if (previous) runtimePool.queueSettingsChange(previous, next);
  }, [runtimePool]);
  const [definedAgents, setDefinedAgents] = useState<DefinedAgentsCapability>();
  const settingsSavePending = useRef(false); const [settingsSaving, setSettingsSaving] = useState(false);
  const [debugModeSaving, setDebugModeSaving] = useState(false);
  const debugModePending = useRef(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(settingsDirty); settingsDirtyRef.current = settingsDirty;
  const sessionIndexRequest = useRef<Promise<void> | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia("(max-width: 700px)").matches); const [query, setQuery] = useState(""); const [connected, setConnected] = useState(false); const connectionReadyRef = useRef(connected); connectionReadyRef.current = connected; const updateConnected = (value: boolean) => { const owned = value && activeTransportRef.current.ownsConversation(); connectionReadyRef.current = owned; setConnected(owned); }; const [error, setError] = useState<string>();
  const [createGroupRequest, setCreateGroupRequest] = useState(0);
  const handleCreateGroup = useCallback(() => setCreateGroupRequest(0), []);
  const [activeHostId, setActiveHostId] = useState(() => transport.currentHostId());
  const [activeCwd, setActiveCwd] = useState<string | undefined>(() => transport.currentCwd());
  const [isGitRepository, setIsGitRepository] = useState<boolean>();
  const activeHostIdRef = useRef(activeHostId); activeHostIdRef.current = activeHostId;
  const [codexUsage, setCodexUsage] = useState<CodexUsage>();
  const [opencodeGoUsage, setOpencodeGoUsage] = useState<OpencodeGoUsage>();
  const opencodeGoBadge = goUsageBadge(opencodeGoUsage);
  const [, setUsageClock] = useState(0);
  const [dialogs, setDialogs] = useState<OwnedExtensionDialog[]>([]); const [notices, setNotices] = useState<Array<{ id: string; title: string; message: string }>>([]);
  const dialogsRef = useRef(dialogs); dialogsRef.current = dialogs;
  const mainDialogOwnerRef = useRef("Main conversation"); mainDialogOwnerRef.current = dialogOwnerName(state.sessionName);
  const addNotice = useCallback((notice: { title: string; message: string }) => setNotices((current) => [...current.slice(-9), { ...notice, id: crypto.randomUUID() }]), []);
  const queueExtensionDialog = useCallback((request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => setDialogs((current) => current.some((dialog) => dialog.transport === ownerTransport && dialog.request.id === request.id) ? current : [...current, { request, transport: ownerTransport, owner, queueId: crypto.randomUUID() }]), []);
  const resolveExtensionDialog = useCallback((owner: NativeTransport, id: string) => setDialogs((current) => current.filter((dialog) => dialog.transport !== owner || dialog.request.id !== id)), []);
  const closeTransportDialogs = useCallback(async (ownerTransport: NativeTransport) => {
    setDialogs((current) => current.filter((dialog) => dialog.transport !== ownerTransport));
  }, []);
  const releaseSplitTransport = useCallback(async (ownerTransport: NativeTransport) => {
    // Selecting a split conversation transfers its runtime to the main pane.
    if (activeTransportRef.current === ownerTransport) return;
    await closeTransportDialogs(ownerTransport);
    if (activeTransportRef.current !== ownerTransport) await runtimePool.release(ownerTransport);
  }, [closeTransportDialogs, runtimePool]);
  const [statuses, setStatuses] = useState<Record<string, string>>({}); const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [extensionOwner, setExtensionOwner] = useState(transport);
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
  const archivedSessionKeys = useRef(new Set<string>());
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
  const terminalLocation = () => {
    const terminalCwd = terminalTarget?.cwd ?? activeCwd ?? sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId)?.cwd;
    const terminalHostId = terminalTarget?.hostId ?? activeHostId;
    return { terminalCwd, terminalHostId };

  };
  const splitSessionId = splitConversationKey(splitPane);
  const terminalSessionId = terminalConversationKey(terminalTarget, activeConversationKey);
  const terminalSessionIdRef = useRef(terminalSessionId); terminalSessionIdRef.current = terminalSessionId;
  const { terminalCwd, terminalHostId } = terminalLocation();
  const composerAndTerminalState = () => {
    const composerDraft = composerDrafts[activeConversationKey] ?? "";
    const composerUploads = uploadsByTransport.get(transport) ?? [];
    const splitComposerDraft = composerDrafts[splitSessionId] ?? "";
    const sessionTerminals = terminalsBySession[terminalSessionId] ?? initialTerminals(terminalSessionId);
    const activeTerminal = sessionTerminals.tabs.find((terminal) => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];
    return { composerDraft, composerUploads, splitComposerDraft, sessionTerminals, activeTerminal };

  };
  const { composerDraft, composerUploads, splitComposerDraft, sessionTerminals, activeTerminal } = composerAndTerminalState();
  const terminalsBySessionRef = useRef(terminalsBySession); terminalsBySessionRef.current = terminalsBySession;
  const activateConversationKey = (key: string) => { activeConversationKeyRef.current = key; setActiveConversationKey(key); };
  useEffect(() => { runtimePool.setErrorHandler((message) => addNotice({ title: message.startsWith("Could not load saved project changes") || message.startsWith("Could not save project changes") ? "Project changes" : "Session", message })); return () => { runtimePool.setErrorHandler(); }; }, [addNotice, runtimePool]);

  const flushTerminalOutput = useCallback(() => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();
    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  }, []);
  const queueTerminalOutput = useCallback((terminalId: string, data: string) => {
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });
    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = window.setTimeout(flushTerminalOutput, 0);
  }, [flushTerminalOutput]);

  useEffect(() => { let cancelled = false; const load = () => { void transport.loadCodexUsage().then((usage) => { if (!cancelled) setCodexUsage(normalizeCodexUsage(usage)); }).catch(() => undefined); void transport.loadOpencodeGoUsage().then((usage) => { if (!cancelled) setOpencodeGoUsage(normalizeOpencodeGoUsage(usage)); }).catch(() => undefined); }; load(); const interval = window.setInterval(load, 60_000); window.addEventListener("focus", load); return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener("focus", load); }; }, [transport]);
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
    document.title = "piop";
    setStatuses({}); setWidgets({});
  }, [transport]);
  useEffect(() => {
    let cancelled = false;
    setIsGitRepository(undefined);
    void transport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [transport]);
  useUsageClock(codexUsage, opencodeGoUsage, setUsageClock);

  useEffect(() => {
    if (!settings || models.length === 0 || settingsSavePending.current) return;
    const next = recordSeenModels(settings, models.map((model) => `${model.provider}/${model.id}`));
    if (!next) return;
    void transport.saveSettings(next, false).then((change) => { if (change?.settings) setSettings(change.settings); }).catch(() => undefined);
  }, [models, settings, transport]);

  const syncSessionIndex = useCallback(() => {
    if (!sessionIndexRequest.current) sessionIndexRequest.current = transport.listSessions().then((nextSessions) => {
      setSessions(nextSessions.filter((session) => !archivedSessionKeys.current.has(`${session.hostId ?? "local"}:${session.id}`)));
      setState((current) => {
        const activeSession = nextSessions.find((session) => session.id === current.sessionId && (session.hostId ?? "local") === activeHostIdRef.current);
        return activeSession && activeSession.name !== current.sessionName ? { ...current, sessionName: activeSession.name } : current;
      });
    }).catch(() => undefined).finally(() => { sessionIndexRequest.current = undefined; });
    return sessionIndexRequest.current;
  }, [transport]);

  useEffect(() => {
    const unsubscribes = [
      listen("pi://sessions-changed", () => { void syncSessionIndex(); }),
      listen<{ hostId: string; line: string }>("pi://daemon-error", ({ payload }) => addNotice({ title: `Connection · ${payload.hostId}`, message: payload.line })),
    ];
    return () => { for (const pending of unsubscribes) void pending.then((unlisten) => unlisten()); };
  }, [addNotice, syncSessionIndex]);

  useEffect(() => {
    const pending = listen<SettingsChange>("pi://settings-changed", ({ payload }) => {
      const next = withClientSettings(payload.settings);
      applyRuntimeSettings(next);
      if (!settingsSavePending.current && !settingsDirtyRef.current) setSettings(next);
    });
    const updateClientPreferences = (event: StorageEvent) => {
      if (event.key !== "piop-client-settings" || settingsSavePending.current || settingsDirtyRef.current) return;
      setSettings((current) => current ? withClientSettings(current) : current);
    };
    window.addEventListener("storage", updateClientPreferences);
    return () => { void pending.then((unlisten) => unlisten()); window.removeEventListener("storage", updateClientPreferences); };
  }, [applyRuntimeSettings]);

  const refresh = useCallback(async (hostId?: string) => {
    void syncSessionIndex();
    const settingsRequest = transport.loadSettings().then((nextSettings) => { applyRuntimeSettings(nextSettings); setSettings(nextSettings); return nextSettings; });
    const [nextState, nextSettings] = await Promise.all([refreshSession(), settingsRequest]); runtimePool.bind(hostId ?? transport.currentHostId(), nextState.sessionId, transport);
    const group = pendingSessionGroups.current.get(transport);
    if (group && nextState.sessionId) {
      try {
        await updateSessionGroups({ type: "assign", key: `${hostId ?? transport.currentHostId()}:${nextState.sessionId}`, group });
        pendingSessionGroups.current.delete(transport);
      } catch (reason) { addNotice({ title: "Could not add chat to group", message: String(reason) }); }
    }
    return nextSettings;
  }, [addNotice, applyRuntimeSettings, refreshSession, runtimePool, syncSessionIndex, transport]);

  const configureRuntime = useCallback(async (value: AppSettings) => {
    if (!transport.ownsConversation()) return;
    if (transport.currentHostId() !== "local") value = await transport.loadHostSettings();
    const [modelResult] = await Promise.allSettled([
      transport.command<{ models: Model[] }>({ type: "get_available_models" }),
      transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
    ]);
    await Promise.all([
      transport.command({ type: "set_auto_compaction", enabled: true }),
      transport.command({ type: "set_auto_retry", enabled: value.autoRetry }),
    ]);
    const availableModels = modelResult.status === "fulfilled" ? modelResult.value.models : [];
    if (transport.needsDefaults()) {
      const defaultModel = availableModels.find((model) => `${model.provider}/${model.id}` === value.defaultModel);
      if (defaultModel) await transport.command({ type: "set_model", provider: defaultModel.provider, modelId: defaultModel.id });
      const { levels } = await transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" });
      if (levels.includes(value.defaultThinking)) await transport.command({ type: "set_thinking_level", level: value.defaultThinking });
      await transport.setFastMode(value.defaultFastMode);
      await transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(value.defaultAgent ?? "general")}` });
      transport.defaultsApplied();
    }
  }, [transport]);
  const resolveHomeDirectory = useCallback((hostId: string) => transport.homeDirectory(hostId), [transport]);

  useAppEvents({ transport, handleEvent, setDialogs, refresh, queueTerminalOutput, setTerminalsBySession, addNotice, activeTransportRef, pendingBtwRequest, setSplitPane, activeHostIdRef, setExtensionOwner, setDefinedAgents, refreshSession, setStatuses, setWidgets, setComposerDrafts, transportConversationKeys, terminalSessionIdRef, setActivePane, setMainComposerFocusRequest, queueExtensionDialog, mainDialogOwnerRef, setActiveHostId, setActiveCwd, activateConversationKey, setTerminalOpen, setTerminalTarget, configureRuntime, setError, updateConnected, terminalOutputFrame, queuedTerminalOutput });

  useEffect(() => { const shutdown = () => { for (const session of Object.values(terminalsBySessionRef.current)) for (const terminal of session.tabs) void transport.closeTerminal(terminal.id).catch(() => undefined); void runtimePool.disconnectAll(); }; window.addEventListener("pagehide", shutdown); return () => window.removeEventListener("pagehide", shutdown); }, [runtimePool, transport]);
  useEffect(() => { if (!settingsDirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [settingsDirty]);
  useEffect(() => { runtimePool.activate(view === "chat" ? transport : undefined); }, [runtimePool, transport, view]);

  useEffect(() => {
    if (!connected || !settings) return;
    const interval = window.setInterval(() => void syncSessionIndex(), settings.hosts.length ? 5000 : 1500);
    return () => window.clearInterval(interval);
  }, [connected, settings, syncSessionIndex]);

  const parseBranchCommand = (branchCommand: RegExpExecArray) => {
    const [, command, rawArgs = ""] = branchCommand;
    const args = rawArgs.trim().split(/\s+/).filter(Boolean);
    const hasNumber = args.length > 0 && /^[+-]?\d/.test(args[0]);
    const number = hasNumber ? args.shift()! : "0";
    if (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error("The response number must be a non-negative integer");
    if (command === "branch-off" && args.length) throw new Error("Usage: /branch-off [number]");
    const responses = messages.filter((message) => message.role === "assistant" && message.entryId && !message.streaming && message.stopReason !== "toolUse" && (message.stopReason === "aborted" || message.stopReason === "error" || (typeof message.content === "string" ? message.content.trim() : message.content.some((part) => part.type === "text" && part.text?.trim()))));
    const message = responses.at(-1 - Number(number));
    if (!message) throw new Error(`No response exists ${number} responses back`);
    return { command, args, message };

  };
  const sendBranchCommand = async (branchCommand: RegExpExecArray, images: ImageAttachment[]) => {
    if (images.length) throw new Error("Branch commands do not accept attachments");
    if (state.isStreaming || state.isPausing) throw new Error("Stop or pause the agent before branching");
    const { command, args, message } = parseBranchCommand(branchCommand);
    if (command === "branch-off") return branchConversation(message);
    if (!isGitRepository || !projectCwd) throw new Error("Open a Git project before creating a worktree");
    const target = { cwd: projectCwd, hostId: activeHostId, message, transport };
    if (!args.length) { setWorktreeTarget(target); return true; }
    await createWorktree(target, args.join(" "));
    return true;
  };
  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (!connectionReadyRef.current) throw new Error("piop is still connecting");
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
    const branchCommand = /^\/(worktree|branch-off)(?:\s+(.*))?$/s.exec(text.trim());
    if (branchCommand) {
      return sendBranchCommand(branchCommand, images);
    }
    if (behavior) { await ownerTransport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); return; }

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
  const transportHasDraft = (owner: NativeTransport, key?: string) => Boolean(key && composerDrafts[key]) || (uploadsByTransport.get(owner)?.length ?? 0) > 0;
  const conversationTerminalIds = (key: string) => terminalsBySession[key]?.tabs.map((terminal) => terminal.id) ?? [];
  const activateTransport = (nextTransport: NativeTransport) => {
    const previousTransport = transport;
    const previousKey = transportConversationKeys.current.get(previousTransport);
    const hasUnsentWork = transportHasDraft(previousTransport, previousKey);
    const discardPrevious = previousTransport !== nextTransport && !runtimePool.isRetained(previousTransport) && !state.isStreaming && state.messageCount === 0 && messages.length === 0 && !hasUnsentWork;
    activeTransportRef.current = nextTransport; runtimePool.activate(nextTransport); setTransport(nextTransport);
    if (discardPrevious) {
      setUploadsByTransport((current) => { const next = new Map(current); next.delete(previousTransport); return next; });
      if (previousKey) {
        setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
        const terminalIds = conversationTerminalIds(previousKey);
        if (terminalIds.length) void Promise.allSettled(terminalIds.map((id) => previousTransport.closeTerminal(id)));
        setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current }; delete next[previousKey]; return next; });
      }
      void runtimePool.release(previousTransport).finally(() => transportConversationKeys.current.delete(previousTransport));
    }
  };
  const rekeyConversationUi = (previousKey: string, nextKey: string, ownerTransport: NativeTransport, moveTerminals = true, copyDraft = false) => {
    if (previousKey === nextKey) return;
    setComposerDrafts((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; if (!copyDraft) delete next[previousKey]; return next; });
    if (moveTerminals) setTerminalsBySession((current) => { if (!(previousKey in current)) return current; const next = { ...current, [nextKey]: current[previousKey] }; delete next[previousKey]; return next; });
    transportConversationKeys.current.set(ownerTransport, nextKey);
    if (ownerTransport === activeTransportRef.current) activateConversationKey(nextKey);
  };
  const branchConversation = createBranchConversation({ transport, activeConversationKeyRef, branchPending, state, sessions, runtimePool, messages, rekeyConversationUi, activeTransportRef, setActiveCwd, setTerminalOpen, setTerminalTarget, setState, setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, addNotice, syncSessionIndex });
  const createWorktree = async (target: WorktreeTarget, name: string, onSetup?: (cancel: (() => Promise<void>) | undefined) => void) => {
    const addWorktreeGroup = async (result: { path: string; branch: string; sessionId?: string }) => {
      try {
        await updateSessionGroups({
          type: "project", project: {
            id: `${target.hostId}:${result.path}`, name: result.branch, cwd: result.path,
            hostId: target.hostId, hostName: settings?.hosts.find((host) => host.id === target.hostId)?.name ?? (target.hostId === "local" ? "Local" : target.hostId),
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
    const branchTransport = runtimePool.forSession(session);
    setComposerUploads(branchTransport, beforePrompt && Array.isArray(sourceMessage.content) ? sourceMessage.content.flatMap((part) => part.type === "image" && part.data && part.mimeType ? [{ id: crypto.randomUUID(), name: "Attached image", kind: "image" as const, byteSize: Math.ceil(part.data.length * 3 / 4), image: { type: "image" as const, data: part.data, mimeType: part.mimeType } }] : []) : []);
    selectSession(session);
    void syncSessionIndex();
    return result;
  };
  const deleteWorktree = async (cwd: string, hostId: string, deleteBranch: boolean) => {
    const result = await transport.removeGitWorktree(cwd, hostId, deleteBranch);
    if (result.warning) addNotice({ title: "Worktree deleted with a warning", message: result.warning });
    void syncSessionIndex();
  };
  const branch = async (message: ChatMessage) => { try { await branchConversation(message); } catch (reason) { addNotice({ title: "Could not branch conversation", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const conversationBusy = () => state.isStreaming || state.isPausing || state.pendingMessageCount;
  const forkAndForget = async (message: ChatMessage) => {
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
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
        discardPendingUpdates(); setState(nextState); setMessages(branchMessages(history.entries, history.leafId));
      }
      void syncSessionIndex();
    } catch (reason) { addNotice({ title: "Could not fork and forget", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { branchPending.current.delete(pendingKey); }
  };
  const confirmNewSession = (clearProject: boolean) => clearProject || !(hasVisibleText(composerDraft) || composerUploads.length) || window.confirm("Start a new conversation and discard the unsent draft?");
  const newSessionTarget = (clearProject: boolean, group?: SessionGroup) => ({ hostId: group ? group.hostId ?? "local" : activeHostIdRef.current, projectCwd: group ? group.cwd ?? undefined : clearProject ? undefined : selectedProjectCwd(activeCwd, transport.isTemporaryChat()) });
  const createSessionTransport = (cwd: string | undefined, hostId: string) => runtimePool.create(cwd ? { cwd, hostId } : { hostId });
  const reportNewSessionFailure = (reason: unknown, conversationKey: string) => { if (activeConversationKeyRef.current === conversationKey) { updateConnected(false); setError(reason instanceof Error ? reason.message : String(reason)); } };
  const startNewSession = async (clearProject = false, group?: SessionGroup) => { if (newSessionPending.current || !canLeaveSettings()) return; if (!confirmNewSession(clearProject)) return; newSessionPending.current = true; const { hostId, projectCwd } = newSessionTarget(clearProject, group); const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; activateConversationKey(conversationKey); setView("chat"); closeSplitPane(); setTerminalOpen(false); setTerminalTarget(undefined); updateConnected(false); setDefinedAgents(undefined); discardPendingUpdates(); const nextTransport = createSessionTransport(projectCwd, hostId); transportConversationKeys.current.set(nextTransport, conversationKey); if (group) pendingSessionGroups.current.set(nextTransport, group.id); try { const cwd = projectCwd ?? await nextTransport.prepareTemporaryChat(hostId); if (activeConversationKeyRef.current !== conversationKey) { transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport); return; } if (clearProject) { setComposerDraft(conversationKey, composerDraft); setComposerUploads(nextTransport, composerUploads); } setActiveCwd(cwd); setActiveHostId(hostId); activateTransport(nextTransport); } catch (reason) { transportConversationKeys.current.delete(nextTransport); void runtimePool.release(nextTransport); reportNewSessionFailure(reason, conversationKey); } finally { newSessionPending.current = false; } };
  const newSession = () => startNewSession();
  const clearChatProject = () => startNewSession(true);
  const isSplitSession = (session: SessionSummary) => splitPane?.session.id === session.id && (splitPane.session.hostId ?? "local") === (session.hostId ?? "local");
  const isSelectedSession = (session: SessionSummary) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId;
  const selectSession = (session: SessionSummary) => {
    if (!canLeaveSettings()) return undefined;
    if (window.matchMedia("(max-width: 700px)").matches) setPanelOpen(false);
    const selectedKey = `${session.hostId ?? "local"}:${session.id}`; if (archivePending.current.has(selectedKey)) return undefined;
    const hostId = session.hostId ?? "local"; if (isSelectedSession(session)) { if (!connected) void transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { setError(undefined); updateConnected(true); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); return transport; }
    if (isSplitSession(session)) closeSplitPane();
    if (session.cwdExists === false) { relocationActionRef.current = "select"; setRelocationError(undefined); setRelocatingSession(session); return undefined; }
    const nextTransport = runtimePool.forSession(session);
    const conversationKey = `${hostId}:${session.id}`; transportConversationKeys.current.set(nextTransport, conversationKey); activateConversationKey(conversationKey); discardPendingUpdates(); setView("chat"); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); setActiveHostId(hostId); setActiveCwd(session.cwd); activateTransport(nextTransport); return nextTransport;
  };
  const enqueueControl = (ownerTransport: NativeTransport, action: () => Promise<void>) => { const previous = controlQueues.current.get(ownerTransport) ?? Promise.resolve(); const next = previous.then(action, action); controlQueues.current.set(ownerTransport, next.catch(() => undefined)); return next; };
  const setModel = async (model: Model) => { const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current; try { await enqueueControl(ownerTransport, async () => { await ownerTransport.command({ type: "set_model", provider: model.provider, modelId: model.id }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await refreshSession(); }); } catch (reason) { addNotice({ title: "Could not change model", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const setThinking = async (level: string) => { const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current; try { await enqueueControl(ownerTransport, async () => { await ownerTransport.command({ type: "set_thinking_level", level }); if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setState((current) => ({ ...current, thinkingLevel: level })); }); } catch (reason) { addNotice({ title: "Could not change thinking level", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const abortInteraction = async () => { const ownerTransport = transport; if (abortPending.current.has(ownerTransport)) return; abortPending.current.add(ownerTransport); try { await ownerTransport.command({ type: "abort" }); } catch (reason) { addNotice({ title: "Could not stop piop", message: reason instanceof Error ? reason.message : String(reason) }); } finally { abortPending.current.delete(ownerTransport); } };
  const pauseInteraction = async () => {
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
    if (abortPending.current.has(ownerTransport) || pauseResumePending.current.has(ownerTransport)) return;
    pauseResumePending.current.add(ownerTransport);
    setState((current) => ({ ...current, isPausing: true }));
    try {
      await ownerTransport.command({ type: "pause" });
      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await refreshSession();
    } catch (reason) {
      addNotice({ title: "Could not pause piop", message: reason instanceof Error ? reason.message : String(reason) });
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
    catch (reason) { addNotice({ title: "Could not resume piop", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { pauseResumePending.current.delete(ownerTransport); }
  };
  const saveSettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig) => {
    if (settingsSavePending.current || debugModePending.current) throw new Error("Wait for the current settings save to finish");
    settingsSavePending.current = true; setSettingsSaving(true);
    try { await applySettings(value, nextConfig, previousConfig); } finally { settingsSavePending.current = false; setSettingsSaving(false); }
  };
  const applySettings = async (value: AppSettings, nextConfig?: AgentConfig, previousConfig?: AgentConfig) => {
    if (!settings) throw new Error("Settings are still loading");
    const next = value;
    const agentHostId = nextConfig ? "local" : undefined;
    // Use a separate, sessionless runtime to persist agent definitions without
    // reloading the extension inside a conversation that is still responding.
    const writeAgents = async (configuration: AgentConfig, defaultModel: string) => {
      const writer = new NativeTransport({ cwd: "~", hostId: "local" });
      try {
        await writer.connect(undefined, undefined, undefined, undefined, true);
        const [provider, ...modelId] = defaultModel.split("/");
        await writer.command({ type: "set_model", provider, modelId: modelId.join("/") });
        await writer.command({ type: "prompt", message: `/pi-define-agents-config ${encodeAgentValue(configuration)}` });
      } finally { await writer.dispose(); }
    };
    let agentsSaved = false;
    let savedChange: SettingsChange;
    try {
      if (nextConfig) { await writeAgents(nextConfig, next.defaultModel); agentsSaved = true; }
      savedChange = await transport.saveSettings(next, false, agentHostId);
    } catch (reason) {
      if (agentsSaved && previousConfig) {
        try { await writeAgents(previousConfig, settings.defaultModel); }
        catch { throw new Error(`Settings could not be saved, and the agent definitions could not be restored: ${reason instanceof Error ? reason.message : String(reason)}`); }
      }
      throw reason;
    }
    setSettings(savedChange.settings);
    applyRuntimeSettings(savedChange.settings);
  };
  const setAgent = async (name: string) => { try { await transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }); } catch (reason) { addNotice({ title: "Could not change agent", message: reason instanceof Error ? reason.message : String(reason) }); } };
  const openProject = async (cwd: string, hostId: string) => { if (!canLeaveSettings()) return; const request = projectOpenRequest.current; const validatedCwd = await transport.validateProjectDirectory(cwd.trim(), hostId); if (!projectOpenRef.current || request !== projectOpenRequest.current) return; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`; projectOpenRef.current = false; setProjectOpen(false); closeSplitPane(); setTerminalOpen(false); updateConnected(false); setDefinedAgents(undefined); discardPendingUpdates(); activateConversationKey(conversationKey); setActiveHostId(hostId); setActiveCwd(validatedCwd); setView("chat"); const nextTransport = runtimePool.create({ cwd: validatedCwd, hostId }); transportConversationKeys.current.set(nextTransport, conversationKey); setComposerDraft(conversationKey, composerDraft); setComposerUploads(nextTransport, composerUploads); activateTransport(nextTransport); };
  const chooseChatProject = () => { projectOpenRequest.current += 1; setProjectOpen(true); };
  const openSplitPane = (session: SessionSummary) => { closeSplitPane(); setSplitPane({ key: crypto.randomUUID(), session }); };
  const openSessionDirectory = async (session: SessionSummary) => {
    const actionKey = `open-directory:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
    try { await transport.openProjectDirectory(session.cwd, session.hostId); }
    catch (reason) { addNotice({ title: "Could not open project directory", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { sessionActionPending.current.delete(actionKey); }
    return;
  };
  const ownsSelectedSession = (owner: NativeTransport, session: SessionSummary) => owner === transport && isSelectedSession(session);
  const ownsConversationUi = (owner: NativeTransport, key: string) => activeTransportRef.current === owner && activeConversationKeyRef.current === key;
  const archiveSession = async (session: SessionSummary) => {
    const archivedSessionKey = `${session.hostId ?? "local"}:${session.id}`;
    if (archivePending.current.has(archivedSessionKey)) return;
    if (!window.confirm(`Archive “${session.name}”?`)) return;
    archivePending.current.add(archivedSessionKey);
    const ownerTransport = runtimePool.forSession(session);
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
    const recoverArchiveFailure = async (reason: unknown) => { if (isActiveSession && activeTransportRef.current === ownerTransport) { try { await ownerTransport.connect(); await refreshSession(); updateConnected(true); } catch { updateConnected(false); } } addNotice({ title: "Could not archive conversation", message: reason instanceof Error ? reason.message : String(reason) }); };
    const connectArchiveReplacement = async (hostId: string, conversationKey: string) => {
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
      } else try { const replacement = runtimePool.create({ cwd: ownerTransport.currentCwd(), hostId }); transportConversationKeys.current.set(replacement, conversationKey); activateTransport(replacement); await runtimePool.release(ownerTransport); }
      catch (reason) { addNotice({ title: "Conversation archived, but a new conversation could not start", message: reason instanceof Error ? reason.message : String(reason) }); void syncSessionIndex(); }
    };
    const replaceArchivedConversation = async () => {
      const hostId = activeHostId; const conversationKey = `${hostId}:draft-${crypto.randomUUID()}`;
      transportConversationKeys.current.set(transport, conversationKey); activateConversationKey(conversationKey); discardPendingUpdates(); setMessages([]);
      setState((value) => ({ ...value, sessionId: "", sessionName: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isPaused: false, isPausing: false, activity: undefined, contextUsage: undefined }));
      await connectArchiveReplacement(hostId, conversationKey);
    };
    try {
      if (runtimePool.isRunning(ownerTransport)) throw new Error("Stop or pause this conversation before archiving it");
      if (splitSession) closeSplitPane();
      if (!isActiveSession) await runtimePool.remove(session);
      else { updateConnected(false); await ownerTransport.disconnect(); }
      await transport.archiveSession(session.path, session.hostId, terminalIds);
      removeArchivedUi();
      if (!isActiveSession) { await syncSessionIndex(); return; }
      if (!ownsConversationUi(ownerTransport, archivedSessionKey)) { await runtimePool.remove(session); await syncSessionIndex(); return; }
      await replaceArchivedConversation();
    } catch (reason) { await recoverArchiveFailure(reason); }
    finally { archivePending.current.delete(archivedSessionKey); }
    return;
  };
  const cloneSelectedSession = async (session: SessionSummary, selectedTransport: NativeTransport) => {
    const sourcePath = session.path; const previousKey = `${session.hostId ?? "local"}:${session.id}`; try { await selectedTransport.connect(); const cloned = await selectedTransport.command<{ cancelled?: boolean }>({ type: "clone" }); if (cloned.cancelled) return; const nextState = await selectedTransport.command<AgentState>({ type: "get_state" }); runtimePool.bind(session.hostId ?? "local", nextState.sessionId, selectedTransport); rekeyConversationUi(previousKey, `${session.hostId ?? "local"}:${nextState.sessionId}`, selectedTransport, true, true); const sourceTransport = runtimePool.forSession(session); setUploadsByTransport((current) => { const next = new Map(current); next.set(sourceTransport, [...(current.get(selectedTransport) ?? [])]); return next; }); const history = await selectedTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); const nextMessages = branchMessages(history.entries, history.leafId); if (activeTransportRef.current === selectedTransport) { setState(nextState); setMessages(nextMessages); updateConnected(true); } try { await runtimePool.copySavedDiffs(selectedTransport, sourcePath, nextState.sessionFile, new Set(nextMessages.map((entry) => entry.id))); } catch (reason) { addNotice({ title: "Conversation cloned, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); } await syncSessionIndex(); } catch (reason) { addNotice({ title: "Could not clone conversation", message: reason instanceof Error ? reason.message : String(reason) }); }
  };
  const cloneSession = async (session: SessionSummary, action: SessionAction) => {
    const actionKey = `${action}:${session.hostId ?? "local"}:${session.id}`; if (sessionActionPending.current.has(actionKey)) return; sessionActionPending.current.add(actionKey);
    try {
      const selectedTransport = selectSession(session); if (!selectedTransport) return;
      if (action === "clone") { await cloneSelectedSession(session, selectedTransport); }
    } finally { sessionActionPending.current.delete(actionKey); }
  };
  const openSessionInWindow = async (session: SessionSummary) => { if (isMobile) { selectSession(session); return; } try { await openSessionWindow({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id, hostId: session.hostId }); } catch (reason) { addNotice({ title: "Could not open window", message: String(reason) }); } };
  const sessionAction = async (session: SessionSummary, action: SessionAction) => {
    if (session.cwdExists === false && (action === "split" || action === "rename")) { relocationActionRef.current = action; setRelocationError(undefined); setRelocatingSession(session); return; }
    if (action === "split") { openSplitPane(session); return; }
    if (action === "new-window") return openSessionInWindow(session);
    if (action === "open-directory") return openSessionDirectory(session);
    if (action === "archive") return archiveSession(session);
    if (action === "rename") { setRenameSession({ session, transport: runtimePool.forSession(session) }); return; }
    return cloneSession(session, action);
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
    if (!settings || debugModePending.current || settingsSavePending.current) return; debugModePending.current = true; setDebugModeSaving(true);
    const next = { ...settings, debugMode: !settings.debugMode };
    void transport.saveSettings(next, false).then(() => { applyRuntimeSettings(next); setSettings(next); }).catch((reason) => addNotice({ title: "Could not change debug mode", message: reason instanceof Error ? reason.message : String(reason) })).finally(() => { debugModePending.current = false; setDebugModeSaving(false); });
  }, [addNotice, applyRuntimeSettings, settings, transport]);
  const reconnectMain = () => {
    const ownerTransport = transport; const ownerKey = activeConversationKeyRef.current;
    if (reconnectPending.current.has(ownerTransport)) return; reconnectPending.current.add(ownerTransport); setError(undefined); updateConnected(false);
    void ownerTransport.connect().then(() => ownerTransport.loadSettings()).then((value) => configureRuntime(value)).then(async () => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) await refreshSession(); }).then(() => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) { setError(undefined); updateConnected(true); void syncSessionIndex(); } }).catch((reason) => { if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === ownerKey) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { reconnectPending.current.delete(ownerTransport); });
  };

  useEffect(() => {
    if (!settings) return;
    const ignoreAppShortcut = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector("dialog[open]")) return true;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      return target?.closest("input, textarea, select, [contenteditable='true'], .keybind-input") && !event.ctrlKey && !event.metaKey;
    };
    const isConversationSearchShortcut = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g";
    const handleKeybind = (event: KeyboardEvent) => {
      if (ignoreAppShortcut(event)) return;
      if (isConversationSearchShortcut(event)) {
        event.preventDefault();
        if (!canLeaveSettings()) return;
        setView("chat"); setPanelOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')?.focus(), 0);
        return;
      }
      const binding = keybindDefinitions.find((item) => matchesShortcut(event, settings.keybindings[item.action]));
      if (!binding) return;
      event.preventDefault();
      const actions: Record<string, () => void> = { newConversation: () => { void newSession(); }, toggleConversations: () => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen((open) => !open); }, toggleTerminal, toggleDebugMode, openSettings: () => setView("settings") };
      if (Object.hasOwn(actions, binding.action)) { actions[binding.action](); return; }
      if (!canLeaveSettings()) return; setView("chat"); window.setTimeout(() => { if (activePane === "split" && splitPane) setSplitComposerFocusRequest((value) => value + 1); else setMainComposerFocusRequest((value) => value + 1); }, 0);
    };
    window.addEventListener("keydown", handleKeybind);
    return () => window.removeEventListener("keydown", handleKeybind);
  }, [settings, toggleDebugMode, settingsDirty, view, activePane, splitPane]);

  useEffect(() => {
    if (!isMobile) return;
    const back = () => { if (view === "settings") { if (canLeaveSettings()) setView("chat"); } else if (terminalOpen) setTerminalOpen(false); else setPanelOpen((value) => !value); };
    window.addEventListener("piop-mobile-back", back);
    return () => window.removeEventListener("piop-mobile-back", back);
  });

  if (!settings) return <AppLoading error={error} />;

  const extensionStateIsCurrent = extensionOwner === transport;
  const activeDialog = dialogs[0];
  const projectCwd = selectedProjectCwd(activeCwd, transport.isTemporaryChat());
  const renderMobileSidebarBackdrop = () => (panelOpen && view === "chat" && <button className="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);
  const renderSidebar = () => {
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="New session group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><IconButton label={settings.debugMode ? "Disable debug mode" : "Enable debug mode"} className={settings.debugMode ? "active" : ""} disabled={debugModeSaving || settingsSaving} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label={view === "settings" ? "Go back" : "Settings"} className={view === "settings" ? "active" : ""} onClick={() => { if (view !== "settings") { setView("settings"); return; } if (canLeaveSettings()) setView("chat"); }}>{view === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { if (canLeaveSettings()) window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}</nav>);
    const renderSessionPanel = () => (view === "chat" && panelOpen && <SessionPanel sessions={[...sessions, ...runtimePool.liveSessionSummaries().filter((live) => !archivedSessionKeys.current.has(`${live.hostId ?? "local"}:${live.id}`) && !sessions.some((saved) => saved.id === live.id && saved.hostId === live.hostId))]} activeId={state.sessionId} activeHostId={activeHostId} runningSessions={runningSessions} unseenSessions={unseenSessions} query={query} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => void startNewSession(false, group)} onCreateWorktree={(cwd, hostId) => setWorktreeTarget({ cwd, hostId, transport })} onDeleteWorktree={deleteWorktree} createGroupRequest={createGroupRequest} onCreateGroupHandled={handleCreateGroup} />);
    const renderUsageBadges = () => (<div className="rail-bottom">{opencodeGoBadge && <LimitBadge label="OpenCode Go" prefix="Go " go detail={opencodeGoBadge.detail} remainingPercent={opencodeGoBadge.window.remainingPercent} resetAt={opencodeGoBadge.window.resetAt} />}{codexUsage !== undefined && <LimitBadge label="Codex" remainingPercent={codexUsage.remainingPercent} resetAt={codexUsage.resetAt} />}</div>);
    return (<ResizableSidebar compact={view === "settings" || !panelOpen}><div className="rail-branch" title={`piop development branch: ${__PIOP_DEVELOPMENT_BRANCH__}`}><GitBranch size={13} /><span>{__PIOP_DEVELOPMENT_BRANCH__}</span></div>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };
  const chatAgentProps = () => { if (!extensionStateIsCurrent) return { agents: [], activeAgent: undefined, agentLocked: false, agentSaved: false, agentUnavailable: false }; return { agents: definedAgents?.config.agents ?? [], activeAgent: definedAgents?.active, agentLocked: definedAgents?.locked, agentSaved: definedAgents?.saved, agentUnavailable: definedAgents?.unavailable }; };
  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<ChatView voiceTransport={transport} key={activeConversationKey} state={state} messages={messages} gitDiffs={gitDiffs} debug={settings.debugMode} {...chatAgentProps()} models={models.filter((model) => !settings.hiddenModels.includes(`${model.provider}/${model.id}`))} commands={[{ name: "branch-off", description: "Branch conversation [number back, default 0]", source: "builtin" }, { name: "worktree", description: "Create worktree [number back, default 0] [name]", source: "builtin" }, ...commands.filter((command) => !["branch-off", "worktree"].includes(command.name))]} thinkingLevels={thinkingLevels} widgets={extensionStateIsCurrent ? Object.values(widgets).flat() : []} statuses={extensionStateIsCurrent ? statuses : {}} projectCwd={projectCwd} controlsDisabled={!connected} selectionBtw draft={composerDraft} onDraftChange={(value) => setComposerDraft(activeConversationKey, value)} focusRequest={mainComposerFocusRequest} onActivate={() => setActivePane("main")} uploads={composerUploads} onUploadsChange={(update) => setComposerUploads(transport, update)} onSend={send} onChangePending={(id, behavior) => transport.changePendingMessage(id, behavior)} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => { terminalPanelRevision.current += 1; setActivePane("main"); setTerminalTarget({ sessionKey: activeConversationKey, cwd: projectCwd, hostId: activeHostId }); setTerminalOpen(true); }} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onBranch={branch} onForkAndForget={isGitRepository === false && projectCwd ? forkAndForget : undefined} onCreateWorktree={isGitRepository && projectCwd ? (message) => setWorktreeTarget({ cwd: projectCwd, hostId: activeHostId, message, transport }) : undefined} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => enqueueControl(transport, () => transport.toggleFastMode())} onThinking={setThinking} />);
      const renderSplitChatPane = () => (splitPane && <SplitChatPane key={splitPane.key} runtimePool={runtimePool} session={splitPane.session} settings={settings} draft={splitComposerDraft} onDraftChange={setSplitComposerDraft} focusRequest={splitComposerFocusRequest} onActivate={() => setActivePane("split")} onOpenTerminal={() => { terminalPanelRevision.current += 1; setActivePane("split"); setTerminalTarget({ sessionKey: splitSessionId, cwd: splitPane.session.cwd, hostId: splitPane.session.hostId ?? "local" }); setTerminalOpen(true); }} onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs} onReleaseTransport={releaseSplitTransport} onSessionChange={(next, owner) => { const nextKey = `${next.hostId ?? "local"}:${next.id}`; rekeyConversationUi(splitSessionId, nextKey, owner); setTerminalTarget((current) => current?.sessionKey === splitSessionId ? { ...current, sessionKey: nextKey } : current); setSplitPane((current) => current?.key === splitPane.key ? { ...current, session: next } : current); }} forkFrom={splitPane.btw?.forkFrom} initialPrompt={splitPane.btw?.task} onReady={splitPane.btw ? () => respondToBtw(splitPane.btw!.requestId, { value: "opened" }) : undefined} onFailed={splitPane.btw ? () => respondToBtw(splitPane.btw!.requestId, { cancelled: true }) : undefined} onClose={closeSplitPane} />);
      return (<div className={`chat-panes ${splitPane ? "split" : ""}`}>
        {renderChatView()}
        {renderSplitChatPane()}
      </div>);
    };
    return (<div className="chat-workspace" hidden={view !== "chat"}>
      {renderChatPanes()}
      {terminalOpen && <TerminalView key={`${terminalSessionId}:${activeTerminal.id}`} cwd={terminalCwd} terminals={sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={activeTerminal.id} output={activeTerminal.output} outputEnd={activeTerminal.outputEnd} snapshot={activeTerminal.snapshot} snapshotEnd={activeTerminal.snapshotEnd} started={activeTerminal.started} exited={activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={(data) => { void transport.writeTerminal(activeTerminal.id, data).catch((reason) => queueTerminalOutput(activeTerminal.id, `\r\nTerminal input failed: ${String(reason)}\r\n`)); }} onResize={(cols, rows) => { void transport.resizeTerminal(activeTerminal.id, cols, rows).catch(() => undefined); }} onSnapshot={(value, outputEnd) => saveTerminalSnapshot(terminalSessionId, activeTerminal.id, value, outputEnd)} onDelete={deleteTerminal} onClose={() => { terminalPanelRevision.current += 1; setTerminalOpen(false); }} />}
    </div>);
  };
  const renderSettingsView = () => (view === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount} settings={settings} sessions={sessions} onSave={saveSettings} onDirtyChange={setSettingsDirty} />);
  const renderToastStack = () => ((error || notices.length > 0) && <div className="toast-stack">
      {error && <div className="error-toast" role="alert"><strong>piop could not connect</strong><span>{error}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport)}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
      {notices.map((notice) => <div className="error-toast" role="alert" key={notice.id}><strong>{notice.title}</strong><span>{notice.message}</span><button aria-label={`Dismiss ${notice.title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}>×</button></div>)}
    </div>);
  const renderExtensionDialog = () => (activeDialog && !projectOpen && !renameSession && !relocatingSession && !worktreeTarget && <ExtensionDialog key={activeDialog.queueId} request={activeDialog.request} owner={activeDialog.owner} onRespond={async (response) => { await activeDialog.transport.command({ type: "extension_ui_response", id: activeDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== activeDialog)); }} />);
  const renderProjectDialog = () => (projectOpen && <ProjectDialog initialPath={projectCwd ?? ""} hosts={settings.hosts} initialHostId={activeHostId} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport.listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const renderRelocationDialog = () => (relocatingSession && <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${relocatingSession.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${relocatingSession.cwd}. Enter its new location to open this conversation.`, error: relocationError, placeholder: "Replacement project directory", prefill: sessions.find((session) => session.id === state.sessionId && (session.hostId ?? "local") === activeHostId && session.cwdExists !== false)?.cwd || "" }} onRespond={async (response) => { if (response.cancelled) { setRelocationError(undefined); setRelocatingSession(undefined); return; } const cwd = typeof response.value === "string" ? response.value.trim() : ""; if (!hasVisibleText(cwd)) { setRelocationError("Path can't be empty"); return; } const session = relocatingSession; const action = relocationActionRef.current; const relocated = { ...session, cwd, cwdExists: true }; setRelocationError(undefined); try { await transport.relocateSession(session.path, cwd, session.hostId); const owner = runtimePool.forSession(session); await owner.restoreConnection({ cwd, sessionPath: session.path, hostId: session.hostId }); setRelocatingSession(undefined); if (action === "split") openSplitPane(relocated); else if (action === "rename") setRenameSession({ session: relocated, transport: runtimePool.forSession(relocated) }); else selectSession(relocated); } catch (reason) { setRelocationError(reason instanceof Error ? reason.message : String(reason)); } }} />);
  const renderWorktreeDialog = () => (worktreeTarget && <WorktreeDialog projectPath={worktreeTarget.cwd} fromProject={!worktreeTarget.message} beforePrompt={worktreeTarget.message?.role === "user"} onCancel={() => setWorktreeTarget(undefined)} onCreate={(name, onSetup) => createWorktree(worktreeTarget, name, onSetup)} />);
  return <div className={`app dark ${panelOpen && view === "chat" ? "mobile-panel-open" : ""}`}>
    <div className="mobile-navigation"><button aria-label="Toggle conversations" aria-expanded={panelOpen && view === "chat"} onClick={() => { if (canLeaveSettings()) { setView("chat"); setPanelOpen((value) => !value); } }}>☰</button></div>
    {renderMobileSidebarBackdrop()}
    {import.meta.env.MODE === "e2e" && <div className="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /></div>}
    {renderSidebar()}
    {renderChatWorkspace()}
    {renderSettingsView()}
    <FindInPage selector=".chat-panes > .chat-shell" scopeKey={activeConversationKey} onActivate={() => setActivePane("main")} active={activePane === "main" || !splitPane} enabled={view === "chat"} />
    {splitPane && <FindInPage key={splitSessionId} selector=".split-chat .chat-shell" scopeKey={splitSessionId} onActivate={() => setActivePane("split")} active={activePane === "split"} enabled={view === "chat"} />}
    {view === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    {renderToastStack()}
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession && <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: renameSession.session.name }} onRespond={async (response) => { if (response.cancelled) { setRenameSession(undefined); return; } if (typeof response.value !== "string" || !hasVisibleText(response.value)) throw new Error("Conversation name can't be empty"); const name = response.value.trim(); await renameSession.transport.connect(); await renameSession.transport.command({ type: "set_session_name", name }); if (renameSession.session.id === state.sessionId && (renameSession.session.hostId ?? "local") === activeHostId) setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}
    {renderRelocationDialog()}
    {renderWorktreeDialog()}
  </div>;
}
