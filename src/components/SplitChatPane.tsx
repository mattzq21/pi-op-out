import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentState, AppSettings, ChatMessage, ComposerUpload, ExtensionUiRequest, ImageAttachment, OrchestrationCapability, PromptContextInfo, RpcEvent, SessionSummary } from "../types";
import { useChatSession } from "../lib/useChatSession";
import { SessionRuntimePool, useTurnDiffs } from "../lib/sessionRuntimePool";
import { decodeOrchestrationValue, encodeOrchestrationValue, ORCHESTRATION_STATUS_KEY } from "../lib/orchestrationProtocol";
import { ChatView } from "./ChatView";
import { ExtensionDialog } from "./ExtensionDialog";

interface Props { runtimePool: SessionRuntimePool; session: SessionSummary; settings: AppSettings; draft: string; onDraftChange: (value: string) => void; forkFrom?: string; initialPrompt?: string; onReady?: () => void; onFailed?: (reason: unknown) => void; onClose: () => void; }
const initialState = (session: SessionSummary): AgentState => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: session.id, sessionName: session.name, messageCount: session.messageCount, pendingMessageCount: 0 });

export function SplitChatPane({ runtimePool, session, settings, draft, onDraftChange, forkFrom, initialPrompt, onReady, onFailed, onClose }: Props) {
  const transport = useMemo(() => runtimePool.create({ cwd: session.cwd, sessionPath: forkFrom ? undefined : session.path, hostId: session.hostId }), [runtimePool]);
  const gitDiffs = useTurnDiffs(runtimePool, transport); const runtime = useChatSession(transport, initialState(session));
  const { state, setState, messages, models, commands, thinkingLevels, refresh, handleEvent } = runtime; const [error, setError] = useState<string>();
  const [promptContext, setPromptContext] = useState<PromptContextInfo>();
  const [orchestration, setOrchestration] = useState<OrchestrationCapability>();
  const [uploads, setUploads] = useState<ComposerUpload[]>([]);
  const [dialogs, setDialogs] = useState<ExtensionUiRequest[]>([]);
  const initialPromptStarted = useRef(false);
  useEffect(() => {
    let closing = false;
    const unsubscribe = transport.subscribe((event: RpcEvent) => {
      handleEvent(event);
      if (event.type === "extension_ui_request") { const request = event as unknown as ExtensionUiRequest;
        if (request.method === "setStatus" && request.statusKey === "pi-desktop-prompt-context") try { setPromptContext(request.statusText?.startsWith("json:") ? JSON.parse(request.statusText.slice(5)) as PromptContextInfo : undefined); } catch { setPromptContext(undefined); }
        else if (request.method === "setStatus" && request.statusKey === ORCHESTRATION_STATUS_KEY) try { setOrchestration(request.statusText?.startsWith("json:") ? decodeOrchestrationValue<OrchestrationCapability>(request.statusText.slice(5)) : undefined); } catch { setOrchestration(undefined); }
        else if (["input", "editor", "select", "confirm"].includes(request.method)) setDialogs((current) => [...current, request]);
      }
      if (event.type === "message_end") window.setTimeout(() => void refresh(), 30);
      if (event.type === "disconnected") { setOrchestration(undefined); if (!closing) setError(["Pi disconnected before responding", transport.lastDiagnostic()].filter(Boolean).join("\n")); }
    });
    transport.connect(session.cwd, forkFrom ? undefined : session.path, session.hostId, forkFrom, Boolean(forkFrom)).then(() => refresh()).then(() => Promise.all([
      transport.command({ type: "set_auto_compaction", enabled: settings.autoCompaction }), transport.command({ type: "set_auto_retry", enabled: settings.autoRetry })
    ])).then(() => {
      if (!initialPrompt || closing) return;
      initialPromptStarted.current = true;
      return transport.command({ type: "prompt", message: initialPrompt }).then(() => { if (!closing) onReady?.(); });
    }).catch((reason) => { if (!closing) { setError(reason instanceof Error ? reason.message : String(reason)); onFailed?.(reason); } });
    return () => { closing = true; unsubscribe(); void runtimePool.release(transport); };
  }, [transport, session.id, forkFrom, initialPrompt, handleEvent, refresh]);
  const send = (text: string, behavior?: "steer" | "followUp", images: ImageAttachment[] = []) => transport.command({ type: behavior === "steer" ? "steer" : behavior === "followUp" ? "follow_up" : "prompt", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  const branch = async (message: ChatMessage) => { try { const index = messages.findIndex((item) => item.id === message.id); const user = messages.slice(0, index + 1).reverse().find((item) => item.role === "user" && item.entryId); if (!user?.entryId) throw new Error("Could not find the message to branch from"); await transport.command({ type: "fork", entryId: user.entryId }); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const abort = async () => { try { await transport.command({ type: "abort" }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  return <section className="split-chat" aria-label={`Split conversation: ${session.name}`}>
    <button className="split-pane-close" aria-label="Close split pane" title="Close split pane" onClick={onClose}><X size={15} /></button>
    {error ? <div className="split-pane-status error">{error}</div> : <ChatView state={state} messages={messages} gitDiffs={gitDiffs} promptContext={promptContext} debug={settings.debugMode} agents={orchestration?.config.agents ?? []} sequences={orchestration?.config.sequences ?? []} activeAgent={orchestration?.active} dictionaries={settings.dictionaries.filter((item) => settings.activeDictionaryIds.includes(item.id))} models={models} commands={commands} thinkingLevels={thinkingLevels} widgets={[]} statuses={[]} projectCwd={session.cwd} controlsDisabled={state.isStreaming || models.length === 0} draft={draft} onDraftChange={onDraftChange} uploads={uploads} onUploadsChange={setUploads} onSend={send} onAbort={() => void abort()} onOpenProject={() => undefined} onBranch={branch} onAgent={(name) => void transport.command({ type: "prompt", message: `/pi-orchestration-use ${encodeOrchestrationValue(name)}` }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))} onModel={(model) => void transport.command({ type: "set_model", provider: model.provider, modelId: model.id }).then(() => refresh()).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))} onThinking={(level) => void transport.command({ type: "set_thinking_level", level }).then(() => setState((current) => ({ ...current, thinkingLevel: level }))).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))} />}
    {dialogs[0] && <ExtensionDialog request={dialogs[0]} onRespond={async (response) => { const request = dialogs[0]; await transport.command({ type: "extension_ui_response", id: request.id, ...response }); setDialogs((current) => current.filter((item) => item.id !== request.id)); }} />}
  </section>;
}
