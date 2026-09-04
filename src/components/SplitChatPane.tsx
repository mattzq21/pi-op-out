import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentState, AppSettings, ChatMessage, ComposerUpload, ExtensionUiRequest, ImageAttachment, OrchestrationCapability, PromptContextInfo, RpcEvent, SessionSummary } from "../types";
import { useChatSession } from "../lib/useChatSession";
import { SessionRuntimePool, useTurnDiffs } from "../lib/sessionRuntimePool";
import type { NativeTransport } from "../lib/nativeTransport";
import { decodeOrchestrationValue, encodeOrchestrationValue, ORCHESTRATION_STATUS_KEY } from "../lib/orchestrationProtocol";
import { ChatView } from "./ChatView";

interface Props { runtimePool: SessionRuntimePool; session: SessionSummary; settings: AppSettings; draft: string; onDraftChange: (value: string) => void; focusRequest?: number; onActivate?: () => void; onOpenTerminal: () => void; onDialogRequest: (request: ExtensionUiRequest, transport: NativeTransport, owner: string) => void; onDialogTransportClosed: (transport: NativeTransport) => Promise<void>; forkFrom?: string; initialPrompt?: string; onReady?: () => void; onFailed?: (reason: unknown) => void; onClose: () => void; }
const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane({ runtimePool, session, settings, draft, onDraftChange, focusRequest = 0, onActivate, onOpenTerminal, onDialogRequest, onDialogTransportClosed, forkFrom, initialPrompt, onReady, onFailed, onClose }: Props) {
  const transport = useMemo(() => runtimePool.create({ cwd: session.cwd, sessionPath: forkFrom ? undefined : session.path, hostId: session.hostId }), [runtimePool]);
  const gitDiffs = useTurnDiffs(runtimePool, transport); const runtime = useChatSession(transport, initialState(session));
  const { state, setState, messages, models, commands, thinkingLevels, refresh, handleEvent } = runtime; const [error, setError] = useState<string>(); const [connected, setConnected] = useState(false);
  const [controlError, setControlError] = useState<string>();
  const connectedRef = useRef(connected); connectedRef.current = connected;
  const updateConnected = (value: boolean) => { connectedRef.current = value; setConnected(value); };
  const [promptContext, setPromptContext] = useState<PromptContextInfo>();
  const [orchestration, setOrchestration] = useState<OrchestrationCapability>();
  const [uploads, setUploads] = useState<ComposerUpload[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [notices, setNotices] = useState<Array<{ id: string; title: string; message: string }>>([]);
  const [extensionFocusRequest, setExtensionFocusRequest] = useState(0);
  const reconnectRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let closing = false; let reconnecting = false; let connectedOnce = false;
    const configure = () => Promise.all([
      transport.command({ type: "set_auto_compaction", enabled: settings.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: settings.autoRetry })
    ]);
    const connectRuntime = async (initial: boolean) => {
      if (reconnecting || closing) return;
      reconnecting = true;
      try {
        if (initial) await transport.connect(session.cwd, forkFrom ? undefined : session.path, session.hostId, forkFrom, Boolean(forkFrom));
        else await transport.connect();
        await refresh(); await configure();
        if (closing) return;
        updateConnected(true); connectedOnce = true; setError(undefined); setControlError(undefined);
        if (initial && initialPrompt) { await transport.command({ type: "prompt", message: initialPrompt }); if (!closing) onReady?.(); }
      } catch (reason) {
        if (closing) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        if (initial && !connectedOnce) setError(message); else setControlError(message);
        if (initial) onFailed?.(reason);
      } finally { reconnecting = false; }
    };
    reconnectRef.current = () => void connectRuntime(false);
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      if (event.type === "extension_ui_request") { const request = event as unknown as ExtensionUiRequest;
        if (request.method === "setStatus" && request.statusKey === "pi-desktop-prompt-context") try { setPromptContext(request.statusText?.startsWith("json:") ? JSON.parse(request.statusText.slice(5)) as PromptContextInfo : undefined); } catch { setPromptContext(undefined); }
        else if (request.method === "setStatus" && request.statusKey === ORCHESTRATION_STATUS_KEY) try { setOrchestration(request.statusText?.startsWith("json:") ? decodeOrchestrationValue<OrchestrationCapability>(request.statusText.slice(5)) : undefined); } catch { setOrchestration(undefined); }
        else if (request.method === "setStatus" && request.statusKey) setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
        else if (request.method === "setWidget" && request.widgetKey) setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = request.widgetLines; else delete next[request.widgetKey!]; return next; });
        else if (request.method === "notify") setNotices((current) => [...current, { id: crypto.randomUUID(), title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "Pi extension", message: request.message || "Notification" }]);
        else if (request.method === "set_editor_text") { onDraftChange(request.text || ""); setExtensionFocusRequest((value) => value + 1); }
        else if (["input", "editor", "select", "confirm"].includes(request.method)) onDialogRequest(request, transport, `Split: ${session.name}`);
      }
      if (event.type === "extension_error") setNotices((current) => [...current, { id: crypto.randomUUID(), title: "Extension error", message: String(event.error ?? "An extension failed") }]);
      if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      if (event.type === "disconnected") { updateConnected(false); setOrchestration(undefined); if (!closing) { setControlError("Connection lost. Reconnecting…"); window.setTimeout(() => void connectRuntime(false), 50); } }
    });
    void connectRuntime(true);
    return () => { closing = true; reconnectRef.current = () => undefined; unsubscribe(); void onDialogTransportClosed(transport).finally(() => runtimePool.release(transport)); };
  }, [transport, session.id, forkFrom, initialPrompt, handleEvent, refresh, onDialogRequest, onDialogTransportClosed]);
  const send = (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (!connectedRef.current) return Promise.reject(new Error("Pi is still connecting"));
    return transport.command({ type: behavior === "steer" ? "steer" : behavior === "followUp" ? "follow_up" : "prompt", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  };
  const reportControlError = (reason: unknown) => setControlError(reason instanceof Error ? reason.message : String(reason));
  const branch = async (message: ChatMessage) => { try { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (!user?.entryId) throw new Error("Could not find the message to branch from"); await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); } catch (reason) { reportControlError(reason); } };
  const abort = async () => { try { await transport.command({ type: "abort" }); } catch (reason) { reportControlError(reason); } };
  return <section className="split-chat" aria-label={`Split conversation: ${session.name}`}>
    <header className="split-pane-header"><span><strong title={session.name}>{session.name}</strong><small title={session.cwd}>{session.project}</small></span><button className="split-pane-close" aria-label="Close split pane" title="Close split pane" onClick={onClose}><X size={15} /></button></header>
    {error ? <div className="split-pane-status error">{error}</div> : <ChatView state={state} messages={messages} gitDiffs={gitDiffs} promptContext={promptContext} debug={settings.debugMode} agents={orchestration?.config.agents ?? []} sequences={orchestration?.config.sequences ?? []} activeAgent={orchestration?.active} dictionaries={settings.dictionaries.filter((item) => settings.activeDictionaryIds.includes(item.id))} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={Object.values(widgets).flat()} statuses={Object.values(statuses)} projectCwd={session.cwd} controlsDisabled={!connected} draft={draft} onDraftChange={onDraftChange} focusRequest={focusRequest + extensionFocusRequest} onActivate={onActivate} uploads={uploads} onUploadsChange={setUploads} onSend={send} onAbort={() => void abort()} onOpenTerminal={onOpenTerminal} onOpenProject={() => undefined} onBranch={branch} onAgent={(name) => void transport.command({ type: "prompt", message: `/pi-orchestration-use ${encodeOrchestrationValue(name)}` }).catch(reportControlError)} onModel={(model) => void transport.command({ type: "set_model", provider: model.provider, modelId: model.id }).then(() => refresh()).catch(reportControlError)} onThinking={(level) => void transport.command({ type: "set_thinking_level", level }).then(() => setState((current) => ({ ...current, thinkingLevel: level }))).catch(reportControlError)} />}
    {controlError && <div className="split-control-error" role="alert"><span>{controlError}</span>{!connected && <button onClick={() => { setControlError("Reconnecting…"); reconnectRef.current(); }}>Retry</button>}<button aria-label="Dismiss split pane error" onClick={() => setControlError(undefined)}>×</button></div>}
    {notices.length > 0 && <div className="split-notices">{notices.map((notice) => <div className="error-toast" role="alert" key={notice.id}><strong>{notice.title}</strong><span>{notice.message}</span><button aria-label={`Dismiss ${notice.title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}>×</button></div>)}</div>}
  </section>;
}
