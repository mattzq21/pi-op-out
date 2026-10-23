import type { ForkSource } from "../types";
import type { HostModelVisibility } from "../lib/hostModelVisibility";
import { required } from "../lib/required";
import { fastModelNames, hostFastModels } from "../lib/fastModels";
import { localHostLabel } from "../lib/mobileHosts";
import { trackToastMessage, trackToastNotices } from "../lib/toastHistory";
import { extensionUiSchema } from "../lib/extensionUiSchema";
import { resolveMessageEntry } from "../lib/resolveMessageEntry";
import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createDependencyEffect, createRef, type StateUpdate } from "../lib/solid";

import { X } from "lucide-solid";
import { splitPaneHandler } from "../plugins";
import type { SplitPaneControls } from "../plugins/types";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "../lib/agentProtocol";
import { definedAgentsCapabilitySchema } from "../lib/agentSchemas";
import { z } from "zod";

import type { NativeTransport } from "../lib/nativeTransport";
import { SessionRuntimePool } from "../lib/sessionRuntimePool";
import { useChatSession } from "../lib/useChatSession";
import { followConversation } from "../plugins/conversation";
import type { AgentState, AppSettings, ChatMessage, ComposerUpload, DefinedAgentsCapability, ExtensionUiRequest, ImageAttachment, RpcEvent, SessionSummary } from "../types";

import { ChatView } from "./ChatView";
import { debugView } from "../lib/debugFeatures";
import type { createConversationDrafts } from "../appDrafts";
import { draftUploadsFromImages, stageDraftSubmission, submitDraftPrompt } from "../lib/draftSubmission";
import { trackChatSubmission, updateChatPreparation, waitForConversationReady } from "../lib/chatSubmission";

interface Props { forkSourceName?: (source: ForkSource) => string | undefined; onOpenForkSource?: (source: ForkSource) => void; drafts: ReturnType<typeof createConversationDrafts>; onArchiveOriginal: (session: SessionSummary) => Promise<void>; uploadsFor: (owner: NativeTransport) => ComposerUpload[]; onUploadsChange: (owner: NativeTransport, update: StateUpdate<ComposerUpload[]>) => void; runtimePool: SessionRuntimePool; session: SessionSummary; settings: AppSettings; modelVisibility: HostModelVisibility; draft: string; focusRequest?: number; onActivate?: () => void; onOpenTerminal: () => void; onDialogRequest: (request: ExtensionUiRequest, transport: NativeTransport, owner: string) => void; onDialogResolved: (transport: NativeTransport, id: string) => void; onDialogTransportClosed: (transport: NativeTransport) => Promise<void>; onReleaseTransport: (transport: NativeTransport) => Promise<void>; pluginPane?: boolean; readOnly?: boolean; actions?: Component<SplitPaneControls>; notice?: Component<{ onShowArchive: () => void }>; onShowArchive: () => void; initialPrompt?: string; initialImages?: ImageAttachment[]; onReady?: () => void; onFailed?: (cause: unknown) => void; onSessionChange: (session: SessionSummary, transport: NativeTransport) => void; onClose: () => void; }

const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane(componentProps: Props) {
  const [transport] = createSignal((() => {
    if (componentProps.readOnly) return componentProps.runtimePool.forReadOnly(componentProps.session);

    return componentProps.pluginPane ? componentProps.runtimePool.forPluginPane(componentProps.session) : componentProps.runtimePool.forSession(componentProps.session);
  })());

  componentProps.drafts.bindTransport(transport(), `${componentProps.session.hostId ?? "local"}:${componentProps.session.id}`);
  const runtime = useChatSession(() => (transport()), () => (initialState(componentProps.session)));
  const session = createMemo(() => (runtime)); const [error, setError] = createSignal<string>(); const [connected, setConnected] = createSignal(false);
  const followSource = () => followConversation(componentProps.runtimePool, transport(), session().state);
  createDependencyEffect(() => componentProps.drafts.bindTransport(transport(), `${componentProps.session.hostId ?? "local"}:${componentProps.session.id}`), () => [componentProps.session.id, componentProps.session.cwd, connected()]);
  const chatCommands = createMemo(() => session().commands);
  const [controlError, setControlError] = createSignal<string>();
  const draftRef = createRef(componentProps.draft); createComputed(() => { draftRef.current = componentProps.draft; });
  const connectedRef = createRef(connected()); createComputed(() => { connectedRef.current = connected(); });
  const updateConnected = (value: boolean) => { connectedRef.current = value; setConnected(value); };

  const [definedAgents, setDefinedAgents] = createSignal<DefinedAgentsCapability>();
  const uploads = () => componentProps.uploadsFor(transport());
  const setUploads = (update: StateUpdate<ComposerUpload[]>) => componentProps.onUploadsChange(transport(), update);
  const [statuses, setStatuses] = createSignal<Record<string, string>>({});
  const [widgets, setWidgets] = createSignal<Record<string, string[]>>({});
  const [notices, setNotices] = createSignal<Array<{ id: string; title: string; message: string }>>([]);
  trackToastNotices("Side pane", notices);
  trackToastMessage("Side pane", "Conversation error", controlError);
  const [extensionFocusRequest, setExtensionFocusRequest] = createSignal(0);
  const reconnectRef = createRef<() => void>(() => undefined);
  const lifecycleRef = createRef(0);
  const [initialPromptPending, setInitialPromptPending] = createSignal(Boolean(componentProps.initialPrompt));
  const paneBusy = () => initialPromptPending() || session().state.isStreaming || session().state.isPaused || session().state.isPausing || session().state.isCompacting || session().state.pendingMessageCount > 0;
  createDependencyEffect(() => { const capturedTransport = transport(); const capturedSession = { ...session() }; const capturedRuntimePool0 = componentProps.runtimePool; const capturedSettings1 = componentProps.settings; const capturedInitialPrompt2 = componentProps.initialPrompt; const capturedOnReady3 = componentProps.onReady; const capturedOnFailed4 = componentProps.onFailed; const capturedSession5 = componentProps.session; const capturedOnDialogTransportClosed7 = componentProps.onDialogTransportClosed; const capturedOnDialogResolved8 = componentProps.onDialogResolved; const capturedOnDialogRequest9 = componentProps.onDialogRequest; const capturedDrafts = componentProps.drafts; const capturedOnReleaseTransport11 = componentProps.onReleaseTransport;
    const lifecycle = ++lifecycleRef.current; let closing = false; let reconnecting = false; let connectedOnce = false;
    capturedRuntimePool0.setInteractive(capturedTransport, true);

    const configure = async () => {
      const runtimeSettings = capturedTransport.currentHostId() === "local" ? capturedSettings1 : await capturedTransport.loadHostSettings();

      await capturedTransport.configureAutomaticBehavior(runtimeSettings.autoRetry);
    };

    const sendInitialPrompt = async (initial: boolean) => {
      if (initial && capturedInitialPrompt2) {
        const images = componentProps.initialImages ?? [];
        const uploads = draftUploadsFromImages(images);
        const staged = await stageDraftSubmission(capturedTransport, { rawText: capturedInitialPrompt2, uploads, consume: false });
        await trackChatSubmission(capturedTransport, capturedInitialPrompt2, images, staged, () => submitDraftPrompt(capturedTransport, { type: "prompt", message: capturedInitialPrompt2, images }));
      }

      if (initial) setInitialPromptPending(false);

      if (initial && !closing) capturedOnReady3?.();
    };

    const reportConnectionFailure = (initial: boolean, cause: unknown) => {
      if (closing) return;
      const message = cause instanceof Error ? cause.message : String(cause);

      if (initial && !connectedOnce) setError(message); else setControlError(message);

      if (initial) capturedOnFailed4?.(cause);
    };

    const connectRuntime = async (initial: boolean) => {
      if (reconnecting || closing) return;
      reconnecting = true;

      try {
        await capturedTransport.connect();

        if (capturedTransport.ownsConversation()) await configure();

        await capturedSession.refresh();

        if (closing) return;
        updateConnected(capturedTransport.ownsConversation()); connectedOnce = true; setError(undefined); setControlError(undefined);
        await sendInitialPrompt(initial);
      } catch (reason) {
        reportConnectionFailure(initial, reason);
      } finally { reconnecting = false; }
    };

    reconnectRef.current = () => void connectRuntime(false);

    const unsubscribe = capturedTransport.subscribe((event: RpcEvent) => {
      capturedSession.handleEvent(event);

      const handleOwnershipLost = (): void => {
        updateConnected(false);
        void capturedOnDialogTransportClosed7(capturedTransport);
      };

      const handleOwnershipAcquired = () => {
        updateConnected(false);
      };

      const handleExtensionUiResolved = () => {
        const id = z.string().safeParse(event.id);

        if (event.type === "extension_ui_resolved" && id.success) capturedOnDialogResolved8(capturedTransport, id.data);
      };

      const handleSessionInfoChanged = () => {
        if (reconnecting) return;

        if (event.type === "session_info_changed" && capturedTransport.promptControls.isApplying()) return;
        void capturedSession.refresh().catch(reportControlError);
      };

      const handleExtensionUiRequest = () => {
        const request = extensionUiSchema.parse(event);

        const handler = request.method === "input" ? splitPaneHandler(request.title) : undefined;

        if (handler) {
          void capturedTransport.command({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(reportControlError);
          setControlError(handler.rejectInSplit);

          return;
        }

        const showDialog = () => capturedOnDialogRequest9(request, capturedTransport, `Split: ${capturedSession5.name}`);

        const methods = {
          setStatus: () => {
            if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) {
              try { setDefinedAgents(request.statusText?.startsWith("json:") ? definedAgentsCapabilitySchema.parse(decodeAgentValue(request.statusText.slice(5))) : undefined); }
              catch (reason) { setDefinedAgents(undefined); reportControlError(new Error(`Could not read agent list: ${reason instanceof Error ? reason.message : String(reason)}`)); }

              if (!reconnecting) void capturedSession.refresh().catch(reportControlError);
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
          set_editor_text: () => { if (request.text !== undefined) capturedDrafts.setTransportDraft(capturedTransport, request.text); setExtensionFocusRequest((value) => value + 1); },
          input: showDialog, editor: showDialog, select: showDialog, confirm: showDialog,
        };

        methods[request.method]();
      };

      const handleExtensionError = () => {
        setNotices((current) => [...current, { id: crypto.randomUUID(), title: "Extension error", message: String(event.error ?? "An extension failed") }]);
      };

      const handleSettingsApplied = () => {
        if (closing) return;

        if (capturedTransport.currentHostId() !== (capturedSession5.hostId ?? "local")) { componentProps.onClose();

        return; }

        if (!reconnecting) void capturedSession.refresh().then(() => { if (!closing) updateConnected(capturedTransport.ownsConversation()); }).catch(reportControlError);
      };

      const handleDisconnected = () => {
        updateConnected(false);
        setDefinedAgents(undefined);
        setStatuses({});
        setWidgets({});
        document.title = "piop";
        void capturedOnDialogTransportClosed7(capturedTransport);

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

    void connectRuntime(true);

    return () => { closing = true; capturedRuntimePool0.setInteractive(capturedTransport, false); document.title = "piop"; reconnectRef.current = () => undefined; unsubscribe(); queueMicrotask(() => { if (lifecycleRef.current === lifecycle) void capturedOnReleaseTransport11(capturedTransport); }); };
  }, () => [transport(), componentProps.pluginPane, componentProps.initialPrompt, session().handleEvent, session().refresh, componentProps.onDialogRequest, componentProps.onDialogTransportClosed, componentProps.onReleaseTransport]);
  createDependencyEffect(() => {
    const capturedConnected = connected(); const capturedTransport = transport(); const capturedSettings0 = componentProps.settings;

 if (!capturedConnected || capturedTransport.currentHostId() !== "local") return; void capturedTransport.configureAutomaticBehavior(capturedSettings0.autoRetry).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))); }, () => [connected(), componentProps.settings.autoRetry, transport()]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => { const capturedTransport = transport();

    await waitForConversationReady(capturedTransport, transport, connected, () => error() ?? controlError());
    updateChatPreparation(capturedTransport, "Sending message…");

    const command = { type: behavior ? behavior === "steer" ? "steer" : "follow_up" : "prompt", message: text };
    const result = await submitDraftPrompt(capturedTransport, images.length ? { ...command, images } : command);

    return result === false ? false : true;
  };

  const reportControlError = (cause: unknown) => setControlError(cause instanceof Error ? cause.message : String(cause));

  const branch = async (message: ChatMessage, mode: "branch" | "fork" | "copy" = "branch") => {
    const finishBranching = beginBranching();
    const capturedTransport = transport(); const capturedSession = { ...session() }; const capturedRuntimePool0 = componentProps.runtimePool; const capturedSession1 = componentProps.session; const capturedOnSessionChange2 = componentProps.onSessionChange;

 try { const entryId = await resolveMessageEntry(capturedTransport, message); const result = await capturedTransport.command({ type: mode === "branch" ? "fork_after" : "copy_after", entryId }, forkAfterResultSchema);

 if (result.cancelled) return false; const nextState = await capturedSession.refresh(); const cwd = mode === "branch" ? branchCwd(result.state?.cwd, nextState.cwd) : capturedSession1.cwd; if (mode === "branch") capturedTransport.adoptBranchCwd(cwd); capturedRuntimePool0.bind(capturedSession1.hostId ?? "local", nextState.sessionId, capturedTransport); capturedOnSessionChange2({ ...capturedSession1, cwd, id: nextState.sessionId, forkSourceId: capturedSession1.id, path: nextState.sessionFile || "", name: nextState.sessionName || capturedSession1.name }, capturedTransport);

 return true; } catch (reason) { reportControlError(reason);

 return false; } finally { finishBranching(); } };

  const forgettingRef = createRef(false);

  const conversationBusy = () => session().state.isStreaming || session().state.isPausing || session().state.pendingMessageCount;

  const forkAndForget = async (message: ChatMessage) => {
    if (forgettingRef.current) return;
    const owner = transport();
    const source = { ...componentProps.session };
    const archiveOriginal = componentProps.onArchiveOriginal;
    forgettingRef.current = true;

    try {
      if (conversationBusy()) throw new Error("Wait for the current response and queued messages to finish first");
      const entryId = await resolveMessageEntry(owner, message);

        if (!await branch({ ...message, entryId }, "copy")) return;

      await archiveOriginal(source);
    } catch (reason) { reportControlError(reason); }
    finally { forgettingRef.current = false; }
  };

  const abort = async () => {
    const capturedTransport = transport();
 await capturedTransport.command({ type: "abort" }); };

  const pause = async () => { const capturedSession = { ...session() }; const capturedTransport = transport();
    capturedSession.setState((current) => ({ ...current, isPausing: true }));

    try { await capturedTransport.command({ type: "pause" }); await capturedSession.refresh(); }
    catch (reason) { capturedSession.setState((current) => ({ ...current, isPausing: false })); throw reason; }
  };

  const resume = async () => {
    const capturedTransport = transport();
 await capturedTransport.command({ type: "resume" }); };

  const chatModels = createMemo(() => componentProps.modelVisibility.visibleModels(componentProps.session.hostId ?? "local", session().models));
  const chatAgents = createMemo(() => (definedAgents()?.config.agents ?? []));
  const chatWidgets = createMemo(() => Object.values(widgets()).flat());

  const agentDefinitionHost = () => (componentProps.session.hostId ?? "local") === "local" ? localHostLabel() : componentProps.session.hostName || componentProps.session.hostId;

  const renderSplitPaneStatus = () => (error() ? <div class="split-pane-status error">{(error())}</div> : <ChatView onNotice={(title, message) => setNotices((current) => [...current, { id: crypto.randomUUID(), title, message }])} followConversation={followSource} readOnly={Boolean(componentProps.readOnly)} agentHostLabel={agentDefinitionHost()} transport={transport()} state={transport().promptControls.state(session().state)} messages={session().messages} debug={debugView(componentProps.settings)} agents={chatAgents()} activeAgent={definedAgents()?.active} agentLocked={definedAgents()?.locked} agentSaved={definedAgents()?.saved} agentUnavailable={definedAgents()?.unavailable} refreshError={session().error} capabilityErrors={session().capabilityErrors} capabilitiesLoading={session().capabilitiesLoading} onRetryCapabilities={session().retryCapabilities} modelAliases={componentProps.modelVisibility.aliases(componentProps.session.hostId ?? "local")} models={chatModels()} commands={chatCommands()} thinkingLevels={transport().promptControls.levels(session().thinkingLevels)} widgets={chatWidgets()} statuses={transport().promptControls.statuses(statuses(), fastModelNames(hostFastModels(componentProps.session.hostId ?? "local")()), transport().promptControls.state(session().state).model)} projectCwd={componentProps.session.cwd} controlsDisabled={!connected()} draft={componentProps.draft} onDraftChange={(update) => componentProps.drafts.setTransportDraft(transport(), update)} focusRequest={(componentProps.focusRequest === undefined ? 0 : componentProps.focusRequest) + extensionFocusRequest()} onActivate={componentProps.onActivate} uploads={uploads()} onUploadsChange={setUploads} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abort} onPause={pause} onResume={resume} onOpenTerminal={componentProps.onOpenTerminal} onOpenProject={() => undefined} onBranch={message => branch(message)} onFork={async message => { await branch(message, "fork"); }} onForkAndForget={forkAndForget} forkSourceName={session().state.forkSource ? componentProps.forkSourceName?.(session().state.forkSource!) : undefined} onOpenForkSource={componentProps.onOpenForkSource} onAgent={(name) => void transport().command({ type: "select_agent", agent: name }).then(() => { transport().promptControls.reset();

  return session().refresh(); }).catch(reportControlError)} onModel={(model) => transport().promptControls.model(model, transport().promptControls.state(session().state).thinkingLevel)} onToggleFastMode={() => transport().promptControls.toggle(statuses())} onThinking={(level) => transport().promptControls.thinking(level)} />);

  const renderSplitControlError = () => (controlError() && <div class="split-control-error" role="alert"><span>{(controlError())}</span>{!connected() && <button onClick={() => { setControlError("Reconnecting…"); reconnectRef.current(); }}>Retry</button>}<button aria-label="Dismiss split pane error" onClick={() => setControlError(undefined)}>×</button></div>);

  const renderActions = () => <Show when={componentProps.actions}>{actions => <Dynamic component={actions()} state={() => session().state} messages={() => session().messages} paneKey={() => componentProps.session.id} connected={connected} busy={paneBusy} reportError={reportControlError} />}</Show>;

  return <section class="split-chat" aria-label={`Split conversation: ${componentProps.session.name}`}>
    <header class="split-pane-header"><span><strong data-tooltip={componentProps.session.name}>{componentProps.session.name}</strong><small data-tooltip={componentProps.session.cwd}>{componentProps.session.project}</small></span><div class="split-pane-actions">{renderActions()}<button class="split-pane-close" aria-label="Close split pane" data-tooltip="Close split pane" onClick={componentProps.onClose}><X size={15} /></button></div></header>
    {renderSplitPaneStatus()}
    <Show when={componentProps.notice}>{notice => <Dynamic component={notice()} onShowArchive={componentProps.onShowArchive} />}</Show>
    {renderSplitControlError()}
    {notices().length > 0 && <div class="split-notices">{<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}</div>}
  </section>;
}

import { beginBranching } from "../lib/branchActivity";
import { branchCwd } from "../lib/branching";
import { forkAfterResultSchema } from "../lib/responseSchemas";
