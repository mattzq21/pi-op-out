import { z } from "zod";
import { required } from "./lib/required";
import { extensionUiSchema } from "./lib/extensionUiSchema";
import { isConversationChanged } from "./lib/conversationChanged";
import { initializeSession } from "./lib/sessionInitialization";
import { type Accessor } from "solid-js";
import { createDependencyEffect, type Dispatch, type RefObject, type StateUpdate } from "./lib/solid";

import { MCP_STATUS_KEY, PROMPT_CONTEXT_STATUS_KEY, staleExtensionContext, type OwnedExtensionDialog, type SplitPaneState, type TerminalTarget } from "./appSupport";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "./lib/agentProtocol";
import { definedAgentsCapabilitySchema } from "./lib/agentSchemas";
import { NativeTransport } from "./lib/nativeTransport";
import { splitPaneHandler } from "./plugins";
import type { SplitPaneRequestHandler } from "./plugins/types";
import type { AgentState, AppSettings, DefinedAgentsCapability, ExtensionUiRequest, RpcEvent } from "./types";

type AppEventsContext = {
  transport: NativeTransport;
  prepareSession: (transport: NativeTransport) => Promise<boolean>;
  handleEvent: (event: RpcEvent) => void;
  setDialogs: Dispatch<StateUpdate<OwnedExtensionDialog[]>>;
  loadSettings: () => Promise<AppSettings>;
  refresh: (hostId?: string, settings?: AppSettings) => Promise<AppSettings>;
  queueTerminalOutput: (terminalId: string, data: string) => void;
  terminalExited: (terminalId: string) => void;
  addNotice: (notice: { title: string; message: string; }) => void;
  activeTransportRef: RefObject<NativeTransport>;
  pendingSplitRequest: RefObject<{ id: string; transport: NativeTransport; command: string } | undefined>;
  commandImages: WeakMap<NativeTransport, import("./types").ImageAttachment[]>;
  setSplitPane: Dispatch<StateUpdate<SplitPaneState | undefined>>;
  activeHostIdRef: RefObject<string>;
  setExtensionOwner: Dispatch<StateUpdate<NativeTransport>>;
  setDefinedAgents: Dispatch<StateUpdate<DefinedAgentsCapability | undefined>>;
  refreshSession: () => Promise<AgentState>;
  setStatuses: Dispatch<StateUpdate<Record<string, string>>>;
  setWidgets: Dispatch<StateUpdate<Record<string, string[]>>>;
  setComposerDraft: (key: string, text: string) => void;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  terminalSessionId: Accessor<string>;
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
  flushTerminalOutput: () => void;
};

export function useAppEvents(options: Accessor<AppEventsContext>) {
  createDependencyEffect(() => { const capturedOptions = options();
    let cancelled = false; let reconnecting = false; let initializing = false;
    const current = () => !cancelled && capturedOptions.activeTransportRef.current === capturedOptions.transport;
    capturedOptions.setError(undefined);
    document.title = "piop"; capturedOptions.setStatuses({}); capturedOptions.setWidgets({});

    const loadSelectedSession = async () => {
      initializing = true;

      try {
        if (!await capturedOptions.prepareSession(capturedOptions.transport) || !current()) return;

        const ready = await initializeSession(current, {
          connect: () => capturedOptions.transport.connect(),
          loadSettings: () => capturedOptions.loadSettings(),
          refresh: (settings) => options().refresh(undefined, settings),
          configure: (settings) => options().configureRuntime(settings),
        });

        if (!ready) return;
        capturedOptions.setActiveCwd(capturedOptions.transport.currentCwd());
        capturedOptions.setError(undefined);
        capturedOptions.updateConnected(true);
      } finally { initializing = false; }
    };

    const unsubscribe = capturedOptions.transport.subscribe((event: RpcEvent) => {
      capturedOptions.handleEvent(event);

      const handleExtensionUiResolved = () => {
        capturedOptions.setDialogs((current) => current.filter((dialog) => dialog.transport !== capturedOptions.transport || dialog.request.id !== event.id));
      };

      const handleTerminalOutput = () => {
        capturedOptions.queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
      };

      const handleTerminalExit = () => {
        const terminalId = z.string().safeParse(event.terminalId);

        if (terminalId.success) capturedOptions.terminalExited(terminalId.data);
      };

      const handleExtensionError = () => {
        const message = String(event.error ?? "An extension failed");

        if (!message.startsWith(staleExtensionContext)) capturedOptions.addNotice({ title: "Extension error", message });
      };

      const handleExtensionUiRequest = () => {
        const request = extensionUiSchema.parse(event);

        if (capturedOptions.transport !== capturedOptions.activeTransportRef.current) return;
        const notifyExtension = () => { if (!event.inputRejected) capturedOptions.addNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "piop extension", message: request.message || "Notification" }); };

        const openSplitPane = (handler: SplitPaneRequestHandler) => {
          try {
            const opened = handler.open(request, { activeHostId: capturedOptions.activeHostIdRef.current, pendingImages: capturedOptions.commandImages.get(capturedOptions.transport), parent: capturedOptions.transport });
            const previous = capturedOptions.pendingSplitRequest.current;

            if (previous && previous.id !== request.id) void previous.transport.command({ type: "extension_ui_response", id: previous.id, cancelled: true }).catch(() => undefined);
            capturedOptions.pendingSplitRequest.current = { id: request.id, transport: capturedOptions.transport, command: handler.command };
            capturedOptions.setSplitPane({ key: crypto.randomUUID(), session: opened.session, request: opened.request });
            capturedOptions.commandImages.delete(capturedOptions.transport);
          } catch (reason) {
            void capturedOptions.transport.command({ type: "extension_ui_response", id: request.id, cancelled: true });
            capturedOptions.addNotice({ title: `Could not start ${handler.command}`, message: reason instanceof Error ? reason.message : String(reason) });
          }
        };

        const setDefinedAgentStatus = () => {
          capturedOptions.setExtensionOwner(capturedOptions.transport);

          try {
            const capability = request.statusText?.startsWith("json:") ? definedAgentsCapabilitySchema.parse(decodeAgentValue(request.statusText.slice(5))) : undefined;
            capturedOptions.setDefinedAgents(capability);

            if (capability && !initializing) void capturedOptions.refreshSession().catch(() => undefined);
          } catch (reason) {
            capturedOptions.setDefinedAgents(undefined);
            capturedOptions.addNotice({ title: "Could not read agent list", message: reason instanceof Error ? reason.message : String(reason) });
          }
        };

        const setExtensionStatus = () => {
          capturedOptions.setExtensionOwner(capturedOptions.transport);
          capturedOptions.setStatuses((current) => { const next = { ...current };

            if (request.statusText) next[required(request.statusKey)] = request.statusText; else delete next[required(request.statusKey)];

            return next; });
        };

        const setExtensionWidget = () => {
          capturedOptions.setExtensionOwner(capturedOptions.transport);
          capturedOptions.setWidgets((current) => { const next = { ...current };

            if (request.widgetLines) next[required(request.widgetKey)] = request.widgetLines.map((line) => line.slice(0, 500)).slice(0, 50); else delete next[required(request.widgetKey)];

            return next; });
        };

        const setExtensionTitle = () => { document.title = request.title || "piop"; };

        const setEditorText = () => {
          const key = capturedOptions.transportConversationKeys.current.get(capturedOptions.transport) ?? capturedOptions.terminalSessionId();

          if (request.text !== undefined) capturedOptions.setComposerDraft(key, request.text);
          capturedOptions.setActivePane("main");
          capturedOptions.setMainComposerFocusRequest((value) => value + 1);
        };

        const handleStatus = () => { if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) return setDefinedAgentStatus();

          if (request.statusKey === MCP_STATUS_KEY) return;

          if (request.statusKey && request.statusKey !== PROMPT_CONTEXT_STATUS_KEY) return setExtensionStatus(); };

        const openExtensionDialog = () => { capturedOptions.queueExtensionDialog(request, capturedOptions.transport, capturedOptions.mainDialogOwnerRef.current); };

        if (request.method === "notify") return notifyExtension();

        const splitHandler = request.method === "input" ? splitPaneHandler(request.title) : undefined;

        if (splitHandler) return openSplitPane(splitHandler);

        if (request.method === "setStatus") return handleStatus();

        if (request.method === "setWidget" && request.widgetKey) return setExtensionWidget();
        const otherMethods = new Map(Object.entries({ setTitle: setExtensionTitle, set_editor_text: setEditorText, input: openExtensionDialog, editor: openExtensionDialog, select: openExtensionDialog, confirm: openExtensionDialog }));

        return otherMethods.get(request.method)?.();
      };

      const handleSessionSwitched = () => {
        if (!initializing) void capturedOptions.refresh().catch(() => undefined);
      };

      const handleSettingsApplied = () => {
        const current = () => !cancelled && capturedOptions.activeTransportRef.current === capturedOptions.transport;

        if (!current()) return;

        if (capturedOptions.transport.currentHostId() !== capturedOptions.activeHostIdRef.current) {
          const conversationKey = `local:draft-${crypto.randomUUID()}`;
          capturedOptions.setActiveHostId(capturedOptions.transport.currentHostId()); capturedOptions.setActiveCwd(capturedOptions.transport.currentCwd());
          capturedOptions.transportConversationKeys.current.set(capturedOptions.transport, conversationKey); capturedOptions.activateConversationKey(conversationKey);
          capturedOptions.setTerminalOpen(false); capturedOptions.setTerminalTarget(undefined);
        }

        if (!initializing) void capturedOptions.refresh().then((value) => current() ? capturedOptions.configureRuntime(value) : undefined).then(() => { if (current()) { capturedOptions.setError(undefined); capturedOptions.updateConnected(true); } }).catch((reason) => { if (current() && !isConversationChanged(reason)) capturedOptions.setError((reason instanceof Error ? reason.message : String(reason))); });
      };

      const handleSessionInfoChanged = () => {
        if (capturedOptions.activeTransportRef.current === capturedOptions.transport) capturedOptions.setActiveCwd(capturedOptions.transport.currentCwd());
        if (!initializing && !capturedOptions.transport.promptControls.isApplying()) void capturedOptions.refreshSession().catch(() => undefined);
      };

      const handleOwnershipLost = () => {
        capturedOptions.updateConnected(false);
        capturedOptions.setDialogs((current) => current.filter((dialog) => dialog.transport !== capturedOptions.transport));
      };

      const handleOwnershipAcquired = () => {
        capturedOptions.updateConnected(false);
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
          void loadSelectedSession().catch((cause: unknown) => { if (current() && !isConversationChanged(cause)) { const message = cause instanceof Error ? cause.message : String(cause); capturedOptions.setError(diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message); } }).finally(() => { reconnecting = false; });
        }, 50);
      };

      const handlers = new Map(Object.entries({
        "extension_ui_resolved": handleExtensionUiResolved,
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
      }));

      handlers.get(event.type)?.();
    });

    loadSelectedSession().catch((cause: unknown) => { if (current() && !isConversationChanged(cause)) capturedOptions.setError(cause instanceof Error ? cause.message : String(cause)); });

    return () => { cancelled = true; unsubscribe(); capturedOptions.flushTerminalOutput(); };
  }, () => [options().addNotice, options().configureRuntime, options().handleEvent, options().loadSettings, options().queueExtensionDialog, options().queueTerminalOutput, options().refresh, options().refreshSession, options().transport]);
}
