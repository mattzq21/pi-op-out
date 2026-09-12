import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentState, AppSettings, ChatMessage, ComposerUpload, ExtensionUiRequest, ImageAttachment, DefinedAgentsCapability, RpcEvent, SessionSummary } from "../types";
import { useChatSession } from "../lib/useChatSession";
import { SessionRuntimePool, useTurnDiffs } from "../lib/sessionRuntimePool";
import type { NativeTransport } from "../lib/nativeTransport";
import { decodeAgentValue, encodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "../lib/agentProtocol";

import { branchMessages, type PiEntry } from "../lib/messages";
import { ChatView } from "./ChatView";

interface Props { runtimePool: SessionRuntimePool; session: SessionSummary; settings: AppSettings; draft: string; onDraftChange: (value: string) => void; focusRequest?: number; onActivate?: () => void; onOpenTerminal: () => void; onDialogRequest: (request: ExtensionUiRequest, transport: NativeTransport, owner: string) => void; onDialogTransportClosed: (transport: NativeTransport) => Promise<void>; onReleaseTransport: (transport: NativeTransport) => Promise<void>; forkFrom?: string; initialPrompt?: string; onReady?: () => void; onFailed?: (reason: unknown) => void; onSessionChange: (session: SessionSummary, transport: NativeTransport) => void; onClose: () => void; }
const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane({ runtimePool, session, settings, draft, onDraftChange, focusRequest = 0, onActivate, onOpenTerminal, onDialogRequest, onDialogTransportClosed, onReleaseTransport, forkFrom, initialPrompt, onReady, onFailed, onSessionChange, onClose }: Props) {
  const [transport] = useState(() => forkFrom ? runtimePool.createEphemeralFork({ cwd: session.cwd, hostId: session.hostId }, forkFrom) : runtimePool.forSession(session));
  const gitDiffs = useTurnDiffs(runtimePool, transport); const runtime = useChatSession(transport, initialState(session));
  const { state, setState, messages, models, commands, thinkingLevels, refresh, handleEvent } = runtime; const [error, setError] = useState<string>(); const [connected, setConnected] = useState(false);
  const [controlError, setControlError] = useState<string>();
  const draftRef = useRef(draft); draftRef.current = draft;
  const connectedRef = useRef(connected); connectedRef.current = connected;
  const updateConnected = (value: boolean) => { connectedRef.current = value; setConnected(value); };

  const [definedAgents, setDefinedAgents] = useState<DefinedAgentsCapability>();
  const [uploads, setUploads] = useState<ComposerUpload[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [notices, setNotices] = useState<Array<{ id: string; title: string; message: string }>>([]);
  const [extensionFocusRequest, setExtensionFocusRequest] = useState(0);
  const reconnectRef = useRef<() => void>(() => undefined);
  const lifecycleRef = useRef(0);
  const controlQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const lifecycle = ++lifecycleRef.current; let closing = false; let reconnecting = false; let connectedOnce = false;
    runtimePool.setInteractive(transport, true);
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
        if (request.method === "setStatus" && request.statusKey === DEFINED_AGENTS_STATUS_KEY) try { setDefinedAgents(request.statusText?.startsWith("json:") ? decodeAgentValue<DefinedAgentsCapability>(request.statusText.slice(5)) : undefined); } catch { setDefinedAgents(undefined); }
        else if (request.method === "setStatus" && request.statusKey && ! ["pi-desktop-prompt-context", "pi-desktop-mcp-status"].includes(request.statusKey)) setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
        else if (request.method === "setWidget" && request.widgetKey) setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = request.widgetLines; else delete next[request.widgetKey!]; return next; });
        else if (request.method === "notify") { if (!event.inputRejected) setNotices((current) => [...current, { id: crypto.randomUUID(), title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "piop extension", message: request.message || "Notification" }]); }
        else if (request.method === "setTitle") document.title = request.title || "piop";
        else if (request.method === "set_editor_text") { if (!draftRef.current && request.text) onDraftChange(request.text); setExtensionFocusRequest((value) => value + 1); }
        else if (["input", "editor", "select", "confirm"].includes(request.method)) onDialogRequest(request, transport, `Split: ${session.name}`);
      }
      if (event.type === "extension_error") setNotices((current) => [...current, { id: crypto.randomUUID(), title: "Extension error", message: String(event.error ?? "An extension failed") }]);
      if (event.type === "message_end") { setError(undefined); window.setTimeout(() => void refresh().catch(reportControlError), 30); }
      if (event.type === "settings_applied") void refresh().then(() => setConnected(true)).catch(reportControlError);
      if (event.type === "disconnected") { updateConnected(false); setDefinedAgents(undefined); setStatuses({}); setWidgets({}); document.title = "piop"; void onDialogTransportClosed(transport); if (!closing) { setControlError("Connection lost. Reconnecting…"); window.setTimeout(() => void connectRuntime(false), 50); } }
    });
    void connectRuntime(true);
    return () => { closing = true; runtimePool.setInteractive(transport, false); document.title = "piop"; reconnectRef.current = () => undefined; unsubscribe(); queueMicrotask(() => { if (lifecycleRef.current === lifecycle) void onReleaseTransport(transport); }); };
  }, [transport, forkFrom, initialPrompt, handleEvent, refresh, onDialogRequest, onDialogTransportClosed, onReleaseTransport]);
  useEffect(() => { if (!connected) return; void Promise.all([transport.command({ type: "set_auto_compaction", enabled: settings.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: settings.autoRetry })]).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))); }, [connected, settings.autoCompaction, settings.autoRetry, transport]);
  const send = async (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => {
    if (!connectedRef.current) return Promise.reject(new Error("piop is still connecting"));
    if (/^\/catch-up(?:\s|$)/.test(text)) { await transport.command({ type: "prompt", message: text }); return true; }
    if (behavior) { await transport.command({ type: behavior === "steer" ? "steer" : "follow_up", message: text, ...(images.length ? { images } : {}) }); return; }

    await transport.command({ type: "prompt", message: text, ...(images.length ? { images } : {}) });
  };
  const reportControlError = (reason: unknown) => setControlError(reason instanceof Error ? reason.message : String(reason));
  const enqueueControl = (action: () => Promise<void>) => { const next = controlQueueRef.current.then(action, action); controlQueueRef.current = next.catch(() => undefined); return next; };
  const branch = async (message: ChatMessage) => { try { if (!message.entryId) throw new Error("Could not find the response to branch from"); const sourcePath = transport.currentSessionPath(); const index = messages.findIndex((entry) => entry.id === message.id); const nextUser = messages.slice(index + 1).find((entry) => entry.role === "user" && entry.entryId); const result = await transport.command<{ cancelled?: boolean }>(nextUser ? { type: "fork", entryId: nextUser.entryId } : { type: "clone" }); if (result.cancelled) return; const nextState = await refresh(); runtimePool.bind(session.hostId ?? "local", nextState.sessionId, transport); onSessionChange({ ...session, id: nextState.sessionId, path: nextState.sessionFile || "", name: nextState.sessionName || session.name }, transport); const history = await transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }); await runtimePool.copySavedDiffs(transport, sourcePath, transport.currentSessionPath(), new Set(branchMessages(history.entries, history.leafId).map((entry) => entry.id))); } catch (reason) { reportControlError(reason); } };
  const abort = async () => { await transport.command({ type: "abort" }); };
  const pause = async () => {
    setState((current) => ({ ...current, isPausing: true }));
    try { await transport.command({ type: "pause" }); await refresh(); }
    catch (reason) { setState((current) => ({ ...current, isPausing: false })); throw reason; }
  };
  const resume = async () => { await transport.command({ type: "resume" }); };
  return <section className="split-chat" aria-label={`Split conversation: ${session.name}`}>
    <header className="split-pane-header"><span><strong title={session.name}>{session.name}</strong><small title={session.cwd}>{session.project}</small></span><button className="split-pane-close" aria-label="Close split pane" title="Close split pane" onClick={onClose}><X size={15} /></button></header>
    {error ? <div className="split-pane-status error">{error}</div> : <ChatView state={state} messages={messages} gitDiffs={gitDiffs} debug={settings.debugMode} agents={definedAgents?.config.agents ?? []} activeAgent={definedAgents?.active} dictionaries={settings.dictionaries.filter((item) => settings.activeDictionaryIds.includes(item.id))} models={models.filter((model) => !settings.hiddenModels.includes(`${model.provider}/${model.id}`))} commands={commands} thinkingLevels={thinkingLevels} widgets={Object.values(widgets).flat()} statuses={statuses} projectCwd={session.cwd} controlsDisabled={!connected} draft={draft} onDraftChange={onDraftChange} focusRequest={focusRequest + extensionFocusRequest} onActivate={onActivate} uploads={uploads} onUploadsChange={setUploads} onSend={send} onChangePending={(id, behavior) => transport.changePendingMessage(id, behavior)} onAbort={abort} onPause={pause} onResume={resume} onOpenTerminal={onOpenTerminal} onOpenProject={() => undefined} onBranch={branch} onAgent={(name) => void transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(name)}` }).then(() => refresh()).catch(reportControlError)} onModel={(model) => void enqueueControl(async () => { await transport.command({ type: "set_model", provider: model.provider, modelId: model.id }); await refresh(); }).catch(reportControlError)} onToggleFastMode={() => enqueueControl(() => transport.toggleFastMode())} onThinking={(level) => void enqueueControl(async () => { await transport.command({ type: "set_thinking_level", level }); setState((current) => ({ ...current, thinkingLevel: level })); }).catch(reportControlError)} />}
    {controlError && <div className="split-control-error" role="alert"><span>{controlError}</span>{!connected && <button onClick={() => { setControlError("Reconnecting…"); reconnectRef.current(); }}>Retry</button>}<button aria-label="Dismiss split pane error" onClick={() => setControlError(undefined)}>×</button></div>}
    {notices.length > 0 && <div className="split-notices">{notices.map((notice) => <div className="error-toast" role="alert" key={notice.id}><strong>{notice.title}</strong><span>{notice.message}</span><button aria-label={`Dismiss ${notice.title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}>×</button></div>)}</div>}
  </section>;
}
