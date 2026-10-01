import { required } from "../lib/required";
import { extensionUiSchema } from "../lib/extensionUiSchema";
import { inheritSessionGroup } from "../lib/sessionGroups";
import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef, type StateUpdate } from "../lib/solid";

import { X } from "lucide-solid";
import { REVIEW_REQUEST_TITLE } from "../appSupport";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY, encodeAgentValue } from "../lib/agentProtocol";
import { definedAgentsCapabilitySchema } from "../lib/agentSchemas";
import { z } from "zod";

import type { NativeTransport } from "../lib/nativeTransport";
import { SessionRuntimePool, useTurnDiffs } from "../lib/sessionRuntimePool";
import { useChatSession } from "../lib/useChatSession";
import type { AgentState, AppSettings, ChatMessage, ComposerUpload, DefinedAgentsCapability, ExtensionUiRequest, ImageAttachment, RpcEvent, SessionSummary } from "../types";

import { branchMessages, type PiEntry } from "../lib/messages";
import { ChatView } from "./ChatView";

const reviewMessageSchema = z.object({ message: z.string().refine(message => Boolean(message.trim()), "A message is required") });

interface Props { uploadsFor: (owner: NativeTransport) => ComposerUpload[]; onUploadsChange: (owner: NativeTransport, update: StateUpdate<ComposerUpload[]>) => void; runtimePool: SessionRuntimePool; session: SessionSummary; settings: AppSettings; draft: string; onDraftChange: (value: StateUpdate<string>) => void; focusRequest?: number; onActivate?: () => void; onOpenTerminal: () => void; onDialogRequest: (request: ExtensionUiRequest, transport: NativeTransport, owner: string) => void; onDialogResolved: (transport: NativeTransport, id: string) => void; onDialogTransportClosed: (transport: NativeTransport) => Promise<void>; onReleaseTransport: (transport: NativeTransport) => Promise<void>; freshReview?: boolean; initialPrompt?: string; initialImages?: ImageAttachment[]; onMessageMain?: (message: string) => Promise<void>; onReady?: () => void; onFailed?: (cause: unknown) => void; onSessionChange: (session: SessionSummary, transport: NativeTransport) => void; onClose: () => void; }

const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane(componentProps: Props) {
  const [transport] = createSignal((() => componentProps.freshReview ? componentProps.runtimePool.forReview(componentProps.session) : componentProps.runtimePool.forSession(componentProps.session))());
  const gitDiffs = useTurnDiffs(() => (componentProps.runtimePool), () => (transport())); const runtime = useChatSession(() => (transport()), () => (initialState(componentProps.session)));
  const session = createMemo(() => (runtime)); const [error, setError] = createSignal<string>(); const [connected, setConnected] = createSignal(false);
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
  const [extensionFocusRequest, setExtensionFocusRequest] = createSignal(0);
  const reconnectRef = createRef<() => void>(() => undefined);
  const lifecycleRef = createRef(0);
  const reviewDeliveries = new Map<string, Promise<string>>();
  createDependencyEffect(() => { const capturedTransport = transport(); const capturedSession = { ...session() }; const capturedRuntimePool0 = componentProps.runtimePool; const capturedSettings1 = componentProps.settings; const capturedInitialPrompt2 = componentProps.initialPrompt; const capturedOnReady3 = componentProps.onReady; const capturedOnFailed4 = componentProps.onFailed; const capturedSession5 = componentProps.session; const capturedFreshReview6 = componentProps.freshReview; const messageMain = componentProps.onMessageMain; const capturedOnDialogTransportClosed7 = componentProps.onDialogTransportClosed; const capturedOnDialogResolved8 = componentProps.onDialogResolved; const capturedOnDialogRequest9 = componentProps.onDialogRequest; const capturedOnDraftChange10 = componentProps.onDraftChange; const capturedOnReleaseTransport11 = componentProps.onReleaseTransport;
    const lifecycle = ++lifecycleRef.current; let closing = false; let reconnecting = false; let connectedOnce = false;
    capturedRuntimePool0.setInteractive(capturedTransport, true);

    const configure = async () => {
      const runtimeSettings = capturedTransport.currentHostId() === "local" ? capturedSettings1 : await capturedTransport.loadHostSettings();

      if (capturedFreshReview6) await capturedTransport.command({ type: "prompt", message: "/pi-orchestration-review-init" });
      await Promise.all([capturedTransport.command({ type: "set_auto_compaction", enabled: true }), capturedTransport.command({ type: "set_auto_retry", enabled: runtimeSettings.autoRetry })]);
    };

    const sendInitialPrompt = async (initial: boolean) => {
      if (initial && capturedInitialPrompt2) { await capturedTransport.submitPrompt({ type: "prompt", message: (capturedInitialPrompt2), images: componentProps.initialImages }); }

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
        if (initial) await capturedTransport.connect(capturedSession5.cwd, capturedSession5.path, capturedSession5.hostId);
        else await capturedTransport.connect();
        await capturedSession.refresh();

        if (capturedTransport.ownsConversation()) await configure();

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

      const handleOwnershipLost = () => {
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
        if (event.type === "session_info_changed" || event.type === "session_switched") void capturedSession.refresh().catch(reportControlError);
      };

      const handleExtensionUiRequest = () => {
        const request = extensionUiSchema.parse(event);

        if (request.method === "input" && request.title === "__piop_review_message_main__") {
          let delivery = reviewDeliveries.get(request.id);

          if (!delivery) {
            delivery = Promise.resolve().then(async () => {
              if (!capturedFreshReview6 || !messageMain) throw new Error("No main conversation is attached to this reviewer");
              const { message } = reviewMessageSchema.parse(JSON.parse(request.placeholder || "{}"));
              await messageMain(message);

              return "delivered";
            }).catch(reason => reason instanceof Error ? reason.message : String(reason));
            reviewDeliveries.set(request.id, delivery);
          }

          void delivery.then(value => capturedTransport.command({ type: "extension_ui_response", id: request.id, value })).catch(reportControlError);

          return;
        }

        if (request.method === "input" && request.title === REVIEW_REQUEST_TITLE) {
          void capturedTransport.command({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(reportControlError);
          setControlError("To start /review from this conversation, select it in the main pane first.");

          return;
        }

        const showDialog = () => capturedOnDialogRequest9(request, capturedTransport, `Split: ${capturedSession5.name}`);

        const methods = {
          setStatus: () => {
            if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) {
              try { setDefinedAgents(request.statusText?.startsWith("json:") ? definedAgentsCapabilitySchema.parse(decodeAgentValue(request.statusText.slice(5))) : undefined); }
              catch { setDefinedAgents(undefined); }
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
          set_editor_text: () => { if (request.text !== undefined) capturedOnDraftChange10(request.text); setExtensionFocusRequest((value) => value + 1); },
          input: showDialog, editor: showDialog, select: showDialog, confirm: showDialog,
        };

        methods[request.method]();
      };

      const handleExtensionError = () => {
        setNotices((current) => [...current, { id: crypto.randomUUID(), title: "Extension error", message: String(event.error ?? "An extension failed") }]);
      };

      const handleMessageEnd = () => {
        setError(undefined);
        window.setTimeout(() => void capturedSession.refresh().catch(reportControlError), 30);
      };

      const handleSettingsApplied = () => {
        if (closing) return;

        if (capturedTransport.currentHostId() !== (capturedSession5.hostId ?? "local")) { componentProps.onClose();

        return; }

        void capturedSession.refresh().then(() => { if (!closing) updateConnected(capturedTransport.ownsConversation()); }).catch(reportControlError);
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
        "message_end": handleMessageEnd,
        "settings_applied": handleSettingsApplied,
        "disconnected": handleDisconnected,
        "connection_restored": handleDisconnected
      }));

      handlers.get(event.type)?.();
    });

    void connectRuntime(true);

    return () => { closing = true; capturedRuntimePool0.setInteractive(capturedTransport, false); document.title = "piop"; reconnectRef.current = () => undefined; unsubscribe(); queueMicrotask(() => { if (lifecycleRef.current === lifecycle) void capturedOnReleaseTransport11(capturedTransport); }); };
  }, () => [transport(), componentProps.freshReview, componentProps.initialPrompt, session().handleEvent, session().refresh, componentProps.onDialogRequest, componentProps.onDialogTransportClosed, componentProps.onReleaseTransport]);
  createDependencyEffect(() => {
    const capturedConnected = connected(); const capturedTransport = transport(); const capturedSettings0 = componentProps.settings;

 if (!capturedConnected || capturedTransport.currentHostId() !== "local") return; void Promise.all([capturedTransport.command({ type: "set_auto_compaction", enabled: true }), capturedTransport.command({ type: "set_auto_retry", enabled: capturedSettings0.autoRetry })]).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))); }, () => [connected(), componentProps.settings.autoRetry, transport()]);

  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => { const capturedTransport = transport();

    if (!connectedRef.current) return Promise.reject(new Error("piop is still connecting"));

    const command = { type: behavior ? behavior === "steer" ? "steer" : "follow_up" : "prompt", message: text };
    await capturedTransport.submitPrompt(images.length ? { ...command, images } : command);
  };

  const reportControlError = (cause: unknown) => setControlError(cause instanceof Error ? cause.message : String(cause));

  const branch = async (message: ChatMessage) => {
    const finishBranching = beginBranching();
    const capturedTransport = transport(); const capturedSession = { ...session() }; const capturedRuntimePool0 = componentProps.runtimePool; const capturedSession1 = componentProps.session; const capturedOnSessionChange2 = componentProps.onSessionChange;

 try { if (!message.entryId) throw new Error("Could not find the response to branch from"); const sourcePath = capturedTransport.currentSessionPath(); const sourceDiffs = await capturedRuntimePool0.captureMemoryDiffs(capturedTransport); const result = await capturedTransport.command<{ cancelled?: boolean }>({ type: "fork_after", entryId: message.entryId });

 if (result.cancelled) return; const nextState = await capturedSession.refresh(); await inheritSessionGroup(`${capturedSession1.hostId ?? "local"}:${capturedSession1.id}`, `${capturedSession1.hostId ?? "local"}:${nextState.sessionId}`, capturedSession1); capturedRuntimePool0.bind(capturedSession1.hostId ?? "local", nextState.sessionId, capturedTransport); capturedOnSessionChange2({ ...capturedSession1, id: nextState.sessionId, path: nextState.sessionFile || "", name: nextState.sessionName || capturedSession1.name }, capturedTransport); const history = await capturedTransport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); await capturedRuntimePool0.copySavedDiffs(capturedTransport, sourcePath, capturedTransport.currentSessionPath(), new Set(branchMessages(history.entries, history.leafId).map((entry) => entry.id)), sourceDiffs); } catch (reason) { reportControlError(reason); } finally { finishBranching(); } };

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

  const chatModels = createMemo(() => session().models.filter(model => !componentProps.settings.hiddenModels.includes(`${model.provider}/${model.id}`)));
  const chatAgents = createMemo(() => (definedAgents()?.config.agents ?? []));
  const chatWidgets = createMemo(() => Object.values(widgets()).flat());

  const renderSplitPaneStatus = () => (error() ? <div class="split-pane-status error">{(error())}</div> : <ChatView transport={transport()} state={transport().promptControls.state(session().state)} messages={session().messages} gitDiffs={gitDiffs()} debug={componentProps.settings.debugMode} agents={chatAgents()} activeAgent={definedAgents()?.active} agentLocked={definedAgents()?.locked} agentSaved={definedAgents()?.saved} agentUnavailable={definedAgents()?.unavailable} models={chatModels()} commands={session().commands} thinkingLevels={transport().promptControls.levels(session().thinkingLevels)} widgets={chatWidgets()} statuses={transport().promptControls.statuses(statuses(), definedAgents()?.config.fastModeModels)} projectCwd={componentProps.session.cwd} controlsDisabled={!connected()} draft={componentProps.draft} onDraftChange={componentProps.onDraftChange} focusRequest={(componentProps.focusRequest === undefined ? 0 : componentProps.focusRequest) + extensionFocusRequest()} onActivate={componentProps.onActivate} uploads={uploads()} onUploadsChange={setUploads} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abort} onPause={pause} onResume={resume} onOpenTerminal={componentProps.onOpenTerminal} onOpenProject={() => undefined} onBranch={branch} onAgent={(name) => void transport().command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }).then(() => { transport().promptControls.reset();

  return session().refresh(); }).catch(reportControlError)} onModel={(model) => transport().promptControls.model(model, transport().promptControls.state(session().state).thinkingLevel)} onToggleFastMode={() => transport().promptControls.toggle(statuses())} onThinking={(level) => transport().promptControls.thinking(level)} />);

  const renderSplitControlError = () => (controlError() && <div class="split-control-error" role="alert"><span>{(controlError())}</span>{!connected() && <button onClick={() => { setControlError("Reconnecting…"); reconnectRef.current(); }}>Retry</button>}<button aria-label="Dismiss split pane error" onClick={() => setControlError(undefined)}>×</button></div>);

  return <section class="split-chat" aria-label={`Split conversation: ${componentProps.session.name}`}>
    <header class="split-pane-header"><span><strong title={componentProps.session.name}>{componentProps.session.name}</strong><small title={componentProps.session.cwd}>{componentProps.session.project}</small></span><button class="split-pane-close" aria-label="Close split pane" title="Close split pane" onClick={componentProps.onClose}><X size={15} /></button></header>
    {renderSplitPaneStatus()}
    {renderSplitControlError()}
    {notices().length > 0 && <div class="split-notices">{<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}</div>}
  </section>;
}

import { beginBranching } from "../lib/branchActivity";
