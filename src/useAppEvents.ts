import type { Dispatch, RefObject } from "react";
import { useEffect, type SetStateAction } from "react";
import { NativeTransport } from "./lib/nativeTransport";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "./lib/agentProtocol";
import type { AgentState, AppSettings, ExtensionUiRequest, DefinedAgentsCapability, RpcEvent } from "./types";
import { staleExtensionContext, type SessionTerminals, type QueuedTerminalOutput, type SplitPaneState, type OwnedExtensionDialog, type TerminalTarget, BTW_REQUEST_TITLE, PROMPT_CONTEXT_STATUS_KEY, MCP_STATUS_KEY } from "./appSupport";

type AppEventsContext = {
  transport: NativeTransport;
  handleEvent: (event: RpcEvent) => void;
  setDialogs: Dispatch<SetStateAction<OwnedExtensionDialog[]>>;
  refresh: (hostId?: string) => Promise<AppSettings>;
  queueTerminalOutput: (terminalId: string, data: string) => void;
  setTerminalsBySession: Dispatch<SetStateAction<Record<string, SessionTerminals>>>;
  addNotice: (notice: { title: string; message: string; }) => void;
  activeTransportRef: RefObject<NativeTransport>;
  pendingBtwRequest: RefObject<{ id: string; transport: NativeTransport; } | undefined>;
  setSplitPane: Dispatch<SetStateAction<SplitPaneState | undefined>>;
  activeHostIdRef: RefObject<string>;
  setExtensionOwner: Dispatch<SetStateAction<NativeTransport>>;
  setDefinedAgents: Dispatch<SetStateAction<DefinedAgentsCapability | undefined>>;
  refreshSession: () => Promise<AgentState>;
  setStatuses: Dispatch<SetStateAction<Record<string, string>>>;
  setWidgets: Dispatch<SetStateAction<Record<string, string[]>>>;
  setComposerDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  terminalSessionIdRef: RefObject<string>;
  setActivePane: Dispatch<SetStateAction<"main" | "split">>;
  setMainComposerFocusRequest: Dispatch<SetStateAction<number>>;
  queueExtensionDialog: (request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => void;
  mainDialogOwnerRef: RefObject<string>;
  setActiveHostId: Dispatch<SetStateAction<string>>;
  setActiveCwd: Dispatch<SetStateAction<string | undefined>>;
  activateConversationKey: (key: string) => void;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  setTerminalTarget: Dispatch<SetStateAction<TerminalTarget | undefined>>;
  configureRuntime: (value: AppSettings) => Promise<void>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  updateConnected: (value: boolean) => void;
  terminalOutputFrame: RefObject<number | undefined>;
  queuedTerminalOutput: RefObject<Map<string, QueuedTerminalOutput>>;
};

export function useAppEvents({ transport, handleEvent, setDialogs, refresh, queueTerminalOutput, setTerminalsBySession, addNotice, activeTransportRef, pendingBtwRequest, setSplitPane, activeHostIdRef, setExtensionOwner, setDefinedAgents, refreshSession, setStatuses, setWidgets, setComposerDrafts, transportConversationKeys, terminalSessionIdRef, setActivePane, setMainComposerFocusRequest, queueExtensionDialog, mainDialogOwnerRef, setActiveHostId, setActiveCwd, activateConversationKey, setTerminalOpen, setTerminalTarget, configureRuntime, setError, updateConnected, terminalOutputFrame, queuedTerminalOutput }: AppEventsContext) {
  useEffect(() => {
    let cancelled = false; let reconnecting = false; const refreshTimers = new Set<number>();
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      const handleExtensionUiResolved = () => {
        setDialogs((current) => current.filter((dialog) => dialog.transport !== transport || dialog.request.id !== event.id));
      };
      const handleMessageEnd = () => {
        const timer = window.setTimeout(() => { refreshTimers.delete(timer); if (!cancelled) void refresh().catch(() => undefined); }, 30);
        refreshTimers.add(timer);
      };
      const handleTerminalOutput = () => {
        queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
      };
      const handleTerminalExit = () => {
        setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal) }])));
      };
      const handleExtensionError = () => {
        const message = String(event.error ?? "An extension failed");
        if (!message.startsWith(staleExtensionContext)) addNotice({ title: "Extension error", message });
      };
      const handleExtensionUiRequest = () => {
        const request = event as unknown as ExtensionUiRequest;
        if (transport !== activeTransportRef.current) return;
        const notifyExtension = () => { if (!event.inputRejected) addNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "piop extension", message: request.message || "Notification" }); };
        const btwPayload = () => {
          const payload = JSON.parse(request.placeholder || "{}") as { task?: unknown; sessionFile?: unknown; cwd?: unknown };
          if (typeof payload.task !== "string" || !payload.task.trim() || typeof payload.sessionFile !== "string" || !payload.sessionFile) throw new Error("Invalid /btw branch request");
          return { task: payload.task, sessionFile: payload.sessionFile, cwd: payload.cwd };
        };
        const openBtw = () => {
          try {
            const payload = btwPayload();
            const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ".";
            const previous = pendingBtwRequest.current;
            if (previous && previous.id !== request.id) void previous.transport.command({ type: "extension_ui_response", id: previous.id, cancelled: true }).catch(() => undefined);
            pendingBtwRequest.current = { id: request.id, transport };
            setSplitPane({
              key: crypto.randomUUID(),
              session: { id: `btw-${request.id}`, path: "", name: "BTW", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: payload.task, messageCount: 0, lastMessageAt: Date.now(), apiCost: 0, hostId: activeHostIdRef.current },
              btw: { task: payload.task, forkFrom: payload.sessionFile, requestId: request.id },
            });
          } catch (reason) {
            void transport.command({ type: "extension_ui_response", id: request.id, cancelled: true });
            addNotice({ title: "Could not start /btw", message: reason instanceof Error ? reason.message : String(reason) });
          }
        };
        const setDefinedAgentStatus = () => {
          setExtensionOwner(transport);
          try {
            const capability = request.statusText?.startsWith("json:") ? decodeAgentValue<DefinedAgentsCapability>(request.statusText.slice(5)) : undefined;
            setDefinedAgents(capability);
            if (capability) void refreshSession().catch(() => undefined);
          } catch { setDefinedAgents(undefined); }
        };
        const setExtensionStatus = () => {
          setExtensionOwner(transport);
          setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
        };
        const setExtensionWidget = () => {
          setExtensionOwner(transport);
          setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = (Array.isArray(request.widgetLines) ? request.widgetLines : []).filter((line): line is string => typeof line === "string").map((line) => line.slice(0, 500)).slice(0, 50); else delete next[request.widgetKey!]; return next; });
        };
        const setExtensionTitle = () => { document.title = request.title || "piop"; };
        const setEditorText = () => {
          setComposerDrafts((current) => { const key = transportConversationKeys.current.get(transport) ?? terminalSessionIdRef.current; const next = { ...current }; if (request.text && !next[key]) next[key] = request.text; return next; });
          setActivePane("main");
          setMainComposerFocusRequest((value) => value + 1);
        };
        const handleStatus = () => { if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) return setDefinedAgentStatus(); if (request.statusKey === MCP_STATUS_KEY) return; if (request.statusKey && request.statusKey !== PROMPT_CONTEXT_STATUS_KEY) return setExtensionStatus(); };
        const openExtensionDialog = () => { queueExtensionDialog(request, transport, mainDialogOwnerRef.current); };
        if (request.method === "notify") return notifyExtension();
        if (request.method === "input" && request.title === BTW_REQUEST_TITLE) return openBtw();
        if (request.method === "setStatus") return handleStatus();
        if (request.method === "setWidget" && request.widgetKey) return setExtensionWidget();
        const otherMethods: Record<string, () => void> = { setTitle: setExtensionTitle, set_editor_text: setEditorText, input: openExtensionDialog, editor: openExtensionDialog, select: openExtensionDialog, confirm: openExtensionDialog };
        if (Object.hasOwn(otherMethods, request.method)) return otherMethods[request.method]();
      };
      const handleSessionSwitched = () => {
        void refresh().catch(() => undefined);
      };
      const handleSettingsApplied = () => {
        if (transport.currentHostId() !== activeHostIdRef.current) {
          const conversationKey = `local:draft-${crypto.randomUUID()}`;
          setActiveHostId(transport.currentHostId()); setActiveCwd(transport.currentCwd());
          transportConversationKeys.current.set(transport, conversationKey); activateConversationKey(conversationKey);
          setTerminalOpen(false); setTerminalTarget(undefined);
        }
        void refresh().then((value) => configureRuntime(value)).then(() => { setError(undefined); updateConnected(true); }).catch((reason) => setError(String(reason)));
      };
      const handleSessionInfoChanged = () => {
        void refresh();
      };
      const handleOwnershipLost = () => {
        updateConnected(false);
        setDialogs((current) => current.filter((dialog) => dialog.transport !== transport));
      };
      const handleOwnershipAcquired = () => {
        updateConnected(true);
      };
      const handleDisconnected = () => {
        setDefinedAgents(undefined);
        setStatuses({});
        setWidgets({});
        document.title = "piop";
        setDialogs((current) => current.filter((dialog) => dialog.transport !== transport));
        updateConnected(false);
        if (reconnecting) return;
        reconnecting = true;
        window.setTimeout(() => {
          if (cancelled) return; const diagnostic = transport.lastDiagnostic();
          void transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { if (!cancelled) { setError(undefined); updateConnected(true); } }).catch((reason: unknown) => { if (!cancelled) { const message = reason instanceof Error ? reason.message : String(reason); setError(diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message); } }).finally(() => { reconnecting = false; });
        }, 50);
      };
      const handlers: Record<string, () => void> = {
        "extension_ui_resolved": handleExtensionUiResolved,
        "message_end": handleMessageEnd,
        "terminal_output": handleTerminalOutput,
        "terminal_exit": handleTerminalExit,
        "extension_error": handleExtensionError,
        "extension_ui_request": handleExtensionUiRequest,
        "session_switched": handleSessionSwitched,
        "settings_applied": handleSettingsApplied,
        "session_info_changed": handleSessionInfoChanged,
        "ownership_lost": handleOwnershipLost,
        "ownership_acquired": handleOwnershipAcquired,
        "disconnected": handleDisconnected
      };
      if (Object.hasOwn(handlers, event.type)) handlers[event.type]();
    });
    transport.connect().then(() => refresh()).then((value) => configureRuntime(value)).then(() => refreshSession()).then(() => { if (!cancelled) { setError(undefined); updateConnected(true); } }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; refreshTimers.forEach(window.clearTimeout); unsubscribe(); if (terminalOutputFrame.current !== undefined) window.clearTimeout(terminalOutputFrame.current); terminalOutputFrame.current = undefined; queuedTerminalOutput.current.clear(); };
  }, [addNotice, configureRuntime, handleEvent, queueExtensionDialog, queueTerminalOutput, refresh, refreshSession, transport]);
}
