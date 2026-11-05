import type { HostModelVisibility } from "../lib/hostModelVisibility";
import { required } from "../lib/required";
import { fastModelNames, hostFastModels } from "../lib/fastModels";
import { localHostLabel } from "../lib/mobileHosts";
import { createToastMessageTracker, createToastNoticeTracker } from "../lib/toastHistory";
import { extensionUiSchema } from "../lib/extensionUiSchema";
import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, untrack } from "solid-js";
import { createDependencyEffect, createRef, type StateUpdate } from "../lib/solid";

import { OPEN_AUXILIARY_CHAT } from "../lib/auxiliaryChats";
import { DEFINED_AGENTS_STATUS_KEY, OPEN_CHAT_AGENT } from "../lib/agentProtocol";
import { agentStatusReader } from "../lib/hostAgents";
import { z } from "zod";

import type { NativeTransport } from "../lib/nativeTransport";
import { SessionRuntimePool } from "../lib/sessionRuntimePool";
import { useChatSession } from "../lib/useChatSession";
import { followConversation } from "../plugins/conversation";
import type { AgentState, AppSettings, ComposerUpload, DefinedAgentsCapability, ExtensionUiRequest, ImageAttachment, RpcEvent, SessionSummary } from "../types";

import { ChatView } from "./ChatView";
import { debugView } from "../lib/debugFeatures";
import type { createConversationDrafts } from "../appDrafts";
import { draftUploadsFromImages, stageDraftSubmission, submitDraftPrompt } from "../lib/draftSubmission";
import { agentStateSchema } from "../lib/responseSchemas";
import { trackChatSubmission, updateChatPreparation, waitForConversationReady } from "../lib/chatSubmission";

interface Props { drafts: ReturnType<typeof createConversationDrafts>; uploadsFor: (owner: NativeTransport) => ComposerUpload[]; onUploadsChange: (owner: NativeTransport, update: StateUpdate<ComposerUpload[]>) => void; runtimePool: SessionRuntimePool; session: SessionSummary; settings: AppSettings; modelVisibility: HostModelVisibility; draft: string; focusRequest?: number; queueHoldRequest?: number; onActivate?: () => void; onOpenTerminal: () => void; onDialogRequest: (request: ExtensionUiRequest, transport: NativeTransport, owner: string) => void; onChatAgentRequest: (owner: NativeTransport, request: { id: string }, session: SessionSummary) => void; onDialogResolved: (transport: NativeTransport, id: string) => void; onDialogTransportClosed: (transport: NativeTransport) => Promise<void>; onReleaseTransport: (transport: NativeTransport) => Promise<void>; initialPrompt?: string; initialImages?: ImageAttachment[]; background?: boolean; onInitialClaim?: () => void; onReady?: () => void; onFailed?: (cause: unknown, unseen: boolean) => void; onClose: () => void; }

const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane(componentProps: Props) {
  const transport = untrack(() => {
    const owner = componentProps.runtimePool.forPluginPane(componentProps.session);
    componentProps.drafts.bindTransport(owner, `${componentProps.session.hostId ?? "local"}:${componentProps.session.id}`);

    return owner;
  });
  const session = useChatSession(() => transport, () => initialState(componentProps.session));
  const [error, setError] = createSignal<string>(); const [connected, setConnected] = createSignal(false);
  const followSource = () => followConversation(componentProps.runtimePool, transport, session.state);
  createDependencyEffect(() => componentProps.drafts.bindTransport(transport, `${componentProps.session.hostId ?? "local"}:${componentProps.session.id}`), () => [componentProps.session.id, componentProps.session.cwd, connected()]);
  const chatCommands = createMemo(() => session.commands);
  const [controlError, setControlError] = createSignal<string>();

  const [definedAgents, setDefinedAgents] = createSignal<DefinedAgentsCapability>();
  const uploads = () => componentProps.uploadsFor(transport);
  const setUploads = (update: StateUpdate<ComposerUpload[]>) => componentProps.onUploadsChange(transport, update);
  const [statuses, setStatuses] = createSignal<Record<string, string>>({});
  const [widgets, setWidgets] = createSignal<Record<string, string[]>>({});
  const [notices, setNotices] = createSignal<Array<{ id: string; title: string; message: string }>>([]);
  createToastNoticeTracker("Side pane", notices);
  createToastMessageTracker("Side pane", "Conversation error", controlError);
  const [extensionFocusRequest, setExtensionFocusRequest] = createSignal(0);
  const reconnectRef = createRef<() => void>(() => undefined);
  const lifecycleRef = createRef(0);
  createDependencyEffect(() => { const onChatAgentRequest = componentProps.onChatAgentRequest; const onClose = componentProps.onClose; const onInitialClaim = componentProps.onInitialClaim; const initialImages = componentProps.initialImages; const capturedRuntimePool0 = componentProps.runtimePool; const capturedSettings1 = componentProps.settings; const capturedInitialPrompt2 = componentProps.initialPrompt; const capturedOnReady3 = componentProps.onReady; const capturedOnFailed4 = componentProps.onFailed; const capturedSession5 = componentProps.session; const capturedOnDialogTransportClosed7 = componentProps.onDialogTransportClosed; const capturedOnDialogResolved8 = componentProps.onDialogResolved; const capturedOnDialogRequest9 = componentProps.onDialogRequest; const capturedDrafts = componentProps.drafts; const capturedOnReleaseTransport11 = componentProps.onReleaseTransport;
    const lifecycle = ++lifecycleRef.current; let closing = false; let reconnecting = false; let connectedOnce = false;
    capturedRuntimePool0.setInteractive(transport, true);

    const configure = async () => {
      const runtimeSettings = transport.currentHostId() === "local" ? capturedSettings1 : await transport.loadHostSettings();

      await transport.configureAutomaticBehavior(runtimeSettings.autoRetry);
    };

    const sendInitialPrompt = async (initial: boolean) => {
      if (initial && capturedInitialPrompt2) {
        onInitialClaim?.();
        const images = initialImages ?? [];
        const uploads = draftUploadsFromImages(images);
        const staged = await stageDraftSubmission(transport, { rawText: capturedInitialPrompt2, uploads, consume: false });
        await trackChatSubmission(transport, capturedInitialPrompt2, images, staged, () => submitDraftPrompt(transport, { type: "prompt", message: capturedInitialPrompt2, images }));
      }

      if (initial) capturedOnReady3?.();
    };

    const reportConnectionFailure = (initial: boolean, cause: unknown) => {
      if (initial) capturedOnFailed4?.(cause, closing && delivering);

      if (closing) return;
      const message = cause instanceof Error ? cause.message : String(cause);

      if (initial && !connectedOnce) setError(message); else setControlError(message);
    };

    const delivering = Boolean(capturedInitialPrompt2);
    const connectRuntime = async (initial: boolean) => {
      if (reconnecting || (closing && !(initial && delivering))) return;
      reconnecting = true;

      try {
        await transport.connect();

        if (transport.ownsConversation()) await configure();

        await session.refresh().catch(async reason => {
          if (!(closing && initial && delivering)) throw reason;
          const state = await transport.command({ type: "get_state" }, agentStateSchema);

          if (state.model) transport.promptControls.useEffectiveModel(state.model);
        });

        if (!closing) { setConnected(transport.ownsConversation()); connectedOnce = true; setError(undefined); setControlError(undefined); }
        else if (!(initial && delivering)) return;
        await sendInitialPrompt(initial);
      } catch (reason) {
        reportConnectionFailure(initial, reason);
      } finally { reconnecting = false; }
    };

    reconnectRef.current = () => void connectRuntime(false);

    const agentStatus = agentStatusReader(() => transport.currentHostId(), () => transport.currentCwd(), capability => { if (!closing) setDefinedAgents(capability); }, reason => { if (!closing) reportControlError(new Error(`Could not read agent list: ${reason instanceof Error ? reason.message : String(reason)}`)); });
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      session.handleEvent(event);

      const handleOwnershipLost = (): void => {
        setConnected(false);
        void capturedOnDialogTransportClosed7(transport);
      };

      const handleOwnershipAcquired = () => {
        setConnected(false);
      };

      const handleExtensionUiResolved = () => {
        const id = z.string().safeParse(event.id);

        if (event.type === "extension_ui_resolved" && id.success) capturedOnDialogResolved8(transport, id.data);
      };

      const handleSessionInfoChanged = () => {
        if (reconnecting) return;

        if (event.type === "session_info_changed" && transport.promptControls.isApplying()) return;
        void session.refresh().catch(reportControlError);
      };

      const handleExtensionUiRequest = () => {
        const request = extensionUiSchema.parse(event);

        if (request.method === "input" && request.title === OPEN_AUXILIARY_CHAT) {
          void transport.command({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(reportControlError);
          setControlError("To start a side chat from this conversation, select it in the main pane first.");

          return;
        }

        if (request.method === "input" && request.title === OPEN_CHAT_AGENT) return onChatAgentRequest(transport, request, capturedSession5);

        const showDialog = () => capturedOnDialogRequest9(request, transport, `Split: ${capturedSession5.name}`);

        const methods = {
          setStatus: () => {
            if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) {
              agentStatus.receive(request.statusText);

              if (!reconnecting) void session.refresh().catch(reportControlError);
            } else if (request.statusKey && !["pi-desktop-prompt-context", "pi-desktop-mcp-status"].includes(request.statusKey)) {
              setStatuses((current) => { const next = { ...current };

              if (request.statusText) next[required(request.statusKey)] = request.statusText; else delete next[required(request.statusKey)];

              return next; });
            }
          },
          setWidget: () => { if (request.widgetKey) setWidgets((current) => { const next = { ...current };

          if (request.widgetLines) next[required(request.widgetKey)] = request.widgetLines; else delete next[required(request.widgetKey)];

          return next; }); },
          notify: () => { if (!event.inputRejected) setNotices((current) => [...current, { id: crypto.randomUUID(), title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "piop extension", message: request.message || "Notification" }]); },
          setTitle: () => { document.title = request.title || "piop"; },
          set_editor_text: () => { if (request.text !== undefined) capturedDrafts.setTransportDraft(transport, request.text); setExtensionFocusRequest((value) => value + 1); },
          input: showDialog, editor: showDialog, select: showDialog, confirm: showDialog,
        };

        methods[request.method]();
      };

      const handleExtensionError = () => {
        setNotices((current) => [...current, { id: crypto.randomUUID(), title: "Extension error", message: String(event.error ?? "An extension failed") }]);
      };

      const handleSettingsApplied = () => {
        if (closing) return;

        if (transport.currentHostId() !== (capturedSession5.hostId ?? "local")) { onClose();

        return; }

        if (!reconnecting) void session.refresh().then(() => { if (!closing) setConnected(transport.ownsConversation()); }).catch(reportControlError);
      };

      const handleDisconnected = () => {
        setConnected(false);
        agentStatus.receive(undefined);
        setStatuses({});
        setWidgets({});
        document.title = "piop";
        void capturedOnDialogTransportClosed7(transport);

        if (!closing) { setControlError("Connection lost. Reconnecting…"); window.setTimeout(() => void connectRuntime(false), 50); }
      };

      const handlers = new Map(Object.entries({
        "ownership_lost": handleOwnershipLost,
        "ownership_acquired": handleOwnershipAcquired,
        "extension_ui_resolved": handleExtensionUiResolved,
        "session_info_changed": handleSessionInfoChanged,
        "session_switched": handleSessionInfoChanged,
        "extension_ui_request": handleExtensionUiRequest,
        "extension_error": handleExtensionError,
        "message_end": (): void => { setError(undefined); },
        "settings_applied": handleSettingsApplied,
        "disconnected": handleDisconnected,
        "connection_restored": handleDisconnected
      }));

      handlers.get(event.type)?.();
    });

    const releaseHold = delivering ? capturedRuntimePool0.hold(transport) : () => undefined;
    const initialDelivery = connectRuntime(true).finally(releaseHold);

    return () => { closing = true; capturedRuntimePool0.setInteractive(transport, false); document.title = "piop"; reconnectRef.current = () => undefined; unsubscribe(); agentStatus.close();
      void (delivering ? initialDelivery : Promise.resolve()).then(() => queueMicrotask(() => { if (lifecycleRef.current === lifecycle) void capturedOnReleaseTransport11(transport); })); };
  }, () => [componentProps.initialPrompt, session.handleEvent, session.refresh, componentProps.onDialogRequest, componentProps.onDialogTransportClosed, componentProps.onReleaseTransport]);
  createDependencyEffect(() => {
    const capturedConnected = connected(); const capturedSettings0 = componentProps.settings;

 if (!capturedConnected || transport.currentHostId() !== "local") return; void transport.configureAutomaticBehavior(capturedSettings0.autoRetry).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))); }, () => [connected(), componentProps.settings.autoRetry]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    await waitForConversationReady(transport, () => transport, connected, conversationError);
    updateChatPreparation(transport, "Sending message…");

    const command = { type: behavior ? behavior === "steer" ? "steer" : "follow_up" : "prompt", message: text };
    const result = await submitDraftPrompt(transport, images.length ? { ...command, images } : command);

    return result === false ? false : true;
  };

  const conversationError = createMemo(() => error() ?? controlError());
  const reportControlError = (cause: unknown) => setControlError(cause instanceof Error ? cause.message : String(cause));

  const abort = async () => { await transport.command({ type: "abort" }); };

  const chatModels = createMemo(() => componentProps.modelVisibility.visibleModels(componentProps.session.hostId ?? "local", session.models));
  const chatAgents = createMemo(() => (definedAgents()?.config.agents ?? []));
  const chatWidgets = createMemo(() => Object.values(widgets()).flat());

  const agentDefinitionHost = () => (componentProps.session.hostId ?? "local") === "local" ? localHostLabel() : componentProps.session.hostName || componentProps.session.hostId;

  const renderSplitPaneStatus = () => (error() ? <div class="split-pane-status error">{(error())}</div> : <ChatView onNotice={(title, message) => setNotices((current) => [...current, { id: crypto.randomUUID(), title, message }])} followConversation={followSource} agentHostLabel={agentDefinitionHost()} transport={transport} state={transport.promptControls.state(session.state)} messages={session.messages} debug={debugView(componentProps.settings)} agents={chatAgents()} activeAgent={definedAgents()?.active} agentSaved={definedAgents()?.saved} agentUnavailable={definedAgents()?.unavailable} refreshError={session.error} capabilityErrors={session.capabilityErrors} capabilitiesLoading={session.capabilitiesLoading} onRetryCapabilities={session.retryCapabilities} modelAliases={componentProps.modelVisibility.aliases(componentProps.session.hostId ?? "local")} models={chatModels()} commands={chatCommands()} thinkingLevels={transport.promptControls.levels(session.thinkingLevels)} widgets={chatWidgets()} statuses={transport.promptControls.statuses(statuses(), fastModelNames(hostFastModels(componentProps.session.hostId ?? "local")()), transport.promptControls.state(session.state).model)} projectCwd={componentProps.session.cwd} controlsDisabled={!connected()} draft={componentProps.draft} onDraftChange={(update) => componentProps.drafts.setTransportDraft(transport, update)} draftSelection={componentProps.drafts.selectionFor(transport)} onDraftSelectionChange={selection => componentProps.drafts.setSelection(transport, selection)} focusRequest={(componentProps.focusRequest === undefined ? 0 : componentProps.focusRequest) + extensionFocusRequest()} initialFocus={!componentProps.background} queueHoldRequest={componentProps.queueHoldRequest} onActivate={componentProps.onActivate} uploads={uploads()} onUploadsChange={setUploads} onSend={send} onChangePending={(id, behavior) => transport.changePendingMessage(id, behavior)} onAbort={abort} onOpenTerminal={componentProps.onOpenTerminal} onOpenProject={() => undefined} onBranch={() => undefined} onAgent={(name) => void transport.command({ type: "select_agent", agent: name }).then(() => { transport.promptControls.reset();

  return session.refresh(); }).catch(reportControlError)} onModel={(model) => transport.promptControls.model(model, transport.promptControls.state(session.state).thinkingLevel)} onToggleFastMode={() => transport.promptControls.toggle(statuses())} onThinking={(level) => transport.promptControls.thinking(level)} />);

  const renderSplitControlError = () => (controlError() && <div class="split-control-error" role="alert"><span>{(controlError())}</span>{!connected() && <button onClick={() => { setControlError("Reconnecting…"); reconnectRef.current(); }}>Retry</button>}<button aria-label="Dismiss split pane error" onClick={() => setControlError(undefined)}>×</button></div>);

  return <section class="split-chat" aria-label={`Side chat: ${componentProps.session.name}`}>
    {renderSplitPaneStatus()}
    {renderSplitControlError()}
    {notices().length > 0 && <div class="split-notices">{<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}</div>}
  </section>;
}


