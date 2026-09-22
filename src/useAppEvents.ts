import { type Accessor } from "solid-js";
import { createDependencyEffect, type Dispatch, type RefObject, type StateUpdate } from "./lib/solid";

import { BTW_REQUEST_TITLE, MCP_STATUS_KEY, PROMPT_CONTEXT_STATUS_KEY, staleExtensionContext, type OwnedExtensionDialog, type QueuedTerminalOutput, type SessionTerminals, type SplitPaneState, type TerminalTarget } from "./appSupport";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "./lib/agentProtocol";
import { NativeTransport } from "./lib/nativeTransport";
import type { AgentState, AppSettings, DefinedAgentsCapability, ExtensionUiRequest, RpcEvent } from "./types";

type AppEventsContext = {
  transport: NativeTransport;
  handleEvent: (event: RpcEvent) => void;
  setDialogs: Dispatch<StateUpdate<OwnedExtensionDialog[]>>;
  refresh: (hostId?: string) => Promise<AppSettings>;
  queueTerminalOutput: (terminalId: string, data: string) => void;
  setTerminalsBySession: Dispatch<StateUpdate<Record<string, SessionTerminals>>>;
  addNotice: (notice: { title: string; message: string; }) => void;
  activeTransportRef: RefObject<NativeTransport>;
  pendingBtwRequest: RefObject<{ id: string; transport: NativeTransport; } | undefined>;
  setSplitPane: Dispatch<StateUpdate<SplitPaneState | undefined>>;
  activeHostIdRef: RefObject<string>;
  setExtensionOwner: Dispatch<StateUpdate<NativeTransport>>;
  setDefinedAgents: Dispatch<StateUpdate<DefinedAgentsCapability | undefined>>;
  refreshSession: () => Promise<AgentState>;
  setStatuses: Dispatch<StateUpdate<Record<string, string>>>;
  setWidgets: Dispatch<StateUpdate<Record<string, string[]>>>;
  setComposerDrafts: Dispatch<StateUpdate<Record<string, string>>>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  terminalSessionIdRef: RefObject<string>;
  setActivePane: Dispatch<StateUpdate<"main" | "split">>;
  setMainComposerFocusRequest: Dispatch<StateUpdate<number>>;
  queueExtensionDialog: (request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => void;
  mainDialogOwnerRef: RefObject<string>;
  setActiveHostId: Dispatch<StateUpdate<string>>;
  setActiveCwd: Dispatch<StateUpdate<string | undefined>>;
  activateConversationKey: (key: string) => void;
  setTerminalOpen: Dispatch<StateUpdate<boolean>>;
  setTerminalTarget: Dispatch<StateUpdate<TerminalTarget | undefined>>;
  configureRuntime: (value: AppSettings) => Promise<void>;
  setError: Dispatch<StateUpdate<string | undefined>>;
  updateConnected: (value: boolean) => void;
  terminalOutputFrame: RefObject<number | undefined>;
  queuedTerminalOutput: RefObject<Map<string, QueuedTerminalOutput>>;
};

export function useAppEvents(options: Accessor<AppEventsContext>) {
  createDependencyEffect(() => { const capturedOptions = options();
    let cancelled = false; let reconnecting = false; const refreshTimers = new Set<number>();
    const loadSelectedSession = async () => {
      const current = () => !cancelled && capturedOptions.activeTransportRef.current === capturedOptions.transport;
      await capturedOptions.transport.connect();
      if (!current()) return;
      const settings = await capturedOptions.refresh();
      if (!current()) return;
      await capturedOptions.configureRuntime(settings);
      if (!current()) return;
      await capturedOptions.refreshSession();
      if (!current()) return;
      capturedOptions.setError(undefined);
      capturedOptions.updateConnected(true);
    };
    const unsubscribe = capturedOptions.transport.subscribe((event: RpcEvent) => {
      capturedOptions.handleEvent(event);
      const handleExtensionUiResolved = () => {
        capturedOptions.setDialogs((current) => current.filter((dialog) => dialog.transport !== capturedOptions.transport || dialog.request.id !== event.id));
      };
      const handleMessageEnd = () => {
        const timer = window.setTimeout(() => { refreshTimers.delete(timer); if (!cancelled) void capturedOptions.refresh().catch(() => undefined); }, 30);
        refreshTimers.add(timer);
      };
      const handleTerminalOutput = () => {
        capturedOptions.queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
      };
      const handleTerminalExit = () => {
        capturedOptions.setTerminalsBySession((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, { ...session, tabs: session.tabs.map((terminal) => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal) }])));
      };
      const handleExtensionError = () => {
        const message = String(event.error ?? "An extension failed");
        if (!message.startsWith(staleExtensionContext)) capturedOptions.addNotice({ title: "Extension error", message });
      };
      const handleExtensionUiRequest = () => {
        const request = event as unknown as ExtensionUiRequest;
        if (capturedOptions.transport !== capturedOptions.activeTransportRef.current) return;
        const notifyExtension = () => { if (!event.inputRejected) capturedOptions.addNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "piop extension", message: request.message || "Notification" }); };
        const btwPayload = () => {
          const payload = JSON.parse(request.placeholder || "{}") as { task?: unknown; sessionFile?: unknown; cwd?: unknown };
          if (typeof payload.task !== "string" || !payload.task.trim() || typeof payload.sessionFile !== "string" || !payload.sessionFile) throw new Error("Invalid /btw branch request");
          return { task: payload.task, sessionFile: payload.sessionFile, cwd: payload.cwd };
        };
        const openBtw = () => {
          try {
            const payload = btwPayload();
            const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ".";
            const previous = capturedOptions.pendingBtwRequest.current;
            if (previous && previous.id !== request.id) void previous.transport.command({ type: "extension_ui_response", id: previous.id, cancelled: true }).catch(() => undefined);
            capturedOptions.pendingBtwRequest.current = { id: request.id, transport: capturedOptions.transport };
            capturedOptions.setSplitPane({
              key: crypto.randomUUID(),
              session: { id: `btw-${request.id}`, path: "", name: "BTW", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: payload.task, messageCount: 0, lastMessageAt: Date.now(), apiCost: 0, hostId: capturedOptions.activeHostIdRef.current },
              btw: { task: payload.task, forkFrom: payload.sessionFile, requestId: request.id },
            });
          } catch (reason) {
            void capturedOptions.transport.command({ type: "extension_ui_response", id: request.id, cancelled: true });
            capturedOptions.addNotice({ title: "Could not start /btw", message: reason instanceof Error ? reason.message : String(reason) });
          }
        };
        const setDefinedAgentStatus = () => {
          capturedOptions.setExtensionOwner(capturedOptions.transport);
          try {
            const capability = request.statusText?.startsWith("json:") ? decodeAgentValue<DefinedAgentsCapability>(request.statusText.slice(5)) : undefined;
            capturedOptions.setDefinedAgents(capability);
            if (capability) void capturedOptions.refreshSession().catch(() => undefined);
          } catch { capturedOptions.setDefinedAgents(undefined); }
        };
        const setExtensionStatus = () => {
          capturedOptions.setExtensionOwner(capturedOptions.transport);
          capturedOptions.setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
        };
        const setExtensionWidget = () => {
          capturedOptions.setExtensionOwner(capturedOptions.transport);
          capturedOptions.setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = (Array.isArray(request.widgetLines) ? request.widgetLines : []).filter((line): line is string => typeof line === "string").map((line) => line.slice(0, 500)).slice(0, 50); else delete next[request.widgetKey!]; return next; });
        };
        const setExtensionTitle = () => { document.title = request.title || "piop"; };
        const setEditorText = () => {
          capturedOptions.setComposerDrafts((current) => { const key = capturedOptions.transportConversationKeys.current.get(capturedOptions.transport) ?? capturedOptions.terminalSessionIdRef.current; const next = { ...current }; if (request.text && !next[key]) next[key] = request.text; return next; });
          capturedOptions.setActivePane("main");
          capturedOptions.setMainComposerFocusRequest((value) => value + 1);
        };
        const handleStatus = () => { if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) return setDefinedAgentStatus(); if (request.statusKey === MCP_STATUS_KEY) return; if (request.statusKey && request.statusKey !== PROMPT_CONTEXT_STATUS_KEY) return setExtensionStatus(); };
        const openExtensionDialog = () => { capturedOptions.queueExtensionDialog(request, capturedOptions.transport, capturedOptions.mainDialogOwnerRef.current); };
        if (request.method === "notify") return notifyExtension();
        if (request.method === "input" && request.title === BTW_REQUEST_TITLE) return openBtw();
        if (request.method === "setStatus") return handleStatus();
        if (request.method === "setWidget" && request.widgetKey) return setExtensionWidget();
        const otherMethods: Record<string, () => void> = { setTitle: setExtensionTitle, set_editor_text: setEditorText, input: openExtensionDialog, editor: openExtensionDialog, select: openExtensionDialog, confirm: openExtensionDialog };
        if (Object.hasOwn(otherMethods, request.method)) return otherMethods[request.method]();
      };
      const handleSessionSwitched = () => {
        void capturedOptions.refresh().catch(() => undefined);
      };
      const handleSettingsApplied = () => {
        if (capturedOptions.transport.currentHostId() !== capturedOptions.activeHostIdRef.current) {
          const conversationKey = `local:draft-${crypto.randomUUID()}`;
          capturedOptions.setActiveHostId(capturedOptions.transport.currentHostId()); capturedOptions.setActiveCwd(capturedOptions.transport.currentCwd());
          capturedOptions.transportConversationKeys.current.set(capturedOptions.transport, conversationKey); capturedOptions.activateConversationKey(conversationKey);
          capturedOptions.setTerminalOpen(false); capturedOptions.setTerminalTarget(undefined);
        }
        void capturedOptions.refresh().then((value) => capturedOptions.configureRuntime(value)).then(() => { capturedOptions.setError(undefined); capturedOptions.updateConnected(true); }).catch((reason) => capturedOptions.setError(String(reason)));
      };
      const handleSessionInfoChanged = () => {
        void capturedOptions.refresh();
      };
      const handleOwnershipLost = () => {
        capturedOptions.updateConnected(false);
        capturedOptions.setDialogs((current) => current.filter((dialog) => dialog.transport !== capturedOptions.transport));
      };
      const handleOwnershipAcquired = () => {
        capturedOptions.updateConnected(true);
      };
      const handleDisconnected = () => {
        capturedOptions.setDefinedAgents(undefined);
        capturedOptions.setStatuses({});
        capturedOptions.setWidgets({});
        document.title = "piop";
        capturedOptions.setDialogs((current) => current.filter((dialog) => dialog.transport !== capturedOptions.transport));
        capturedOptions.updateConnected(false);
        if (reconnecting) return;
        reconnecting = true;
        window.setTimeout(() => {
          if (cancelled) return; const diagnostic = capturedOptions.transport.lastDiagnostic();
          void loadSelectedSession().catch((reason: unknown) => { if (!cancelled) { const message = reason instanceof Error ? reason.message : String(reason); capturedOptions.setError(diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message); } }).finally(() => { reconnecting = false; });
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
        "disconnected": handleDisconnected,
        "connection_restored": handleDisconnected
      };
      if (Object.hasOwn(handlers, event.type)) handlers[event.type]();
    });
    loadSelectedSession().catch((reason: unknown) => { if (!cancelled) capturedOptions.setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; refreshTimers.forEach(window.clearTimeout); unsubscribe(); if (capturedOptions.terminalOutputFrame.current !== undefined) window.clearTimeout(capturedOptions.terminalOutputFrame.current); capturedOptions.terminalOutputFrame.current = undefined; capturedOptions.queuedTerminalOutput.current.clear(); };
  }, () => [options().addNotice, options().configureRuntime, options().handleEvent, options().queueExtensionDialog, options().queueTerminalOutput, options().refresh, options().refreshSession, options().transport]);
}
