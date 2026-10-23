import { createSignal } from "solid-js";
import { X } from "lucide-solid";
import { NativeTransport } from "../lib/nativeTransport";
import { createDependencyEffect } from "../lib/solid";
import type { SubagentTarget } from "../lib/subagentNavigation";
import { useChatSession } from "../lib/useChatSession";
import { ChatView } from "./ChatView";
import type { DebugView } from "../lib/debugFeatures";

const noop = () => undefined;

export function SubagentPane(props: { target: SubagentTarget; debug: DebugView; onClose: () => void; onActivate: () => void; onShowArchive: () => void }) {
  const transport = new NativeTransport({ ...props.target, readOnly: true });
  const session = useChatSession(() => transport, () => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: props.target.sessionId, sessionName: props.target.name, messageCount: 0, pendingMessageCount: 0 }), { poll: false });
  const [loaded, setLoaded] = createSignal(false);
  const [archived, setArchived] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [retry, setRetry] = createSignal(0);
  createDependencyEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = (delay: number) => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), delay);
    };

    const refresh = async () => {
      try {
        await transport.connect();
        setArchived(transport.isArchived());

        if (closed) return;
        await session.refresh();

        if (!closed) { setLoaded(true); setError(undefined); }
      } catch (reason) {
        if (!closed) setError(reason instanceof Error ? reason.message : String(reason));
        scheduleRefresh(1000);
      }
    };

    const unsubscribe = transport.subscribe(event => {
      session.handleEvent(event);

      if (event.type === "disconnected" || event.type === "connection_restored") scheduleRefresh(50);
    });
    transport.setVisible(true);
    void refresh();

    return () => { closed = true; clearTimeout(timer); unsubscribe(); transport.setVisible(false); };
  }, () => [retry()]);
  createDependencyEffect(() => () => { void transport.dispose().catch(() => undefined); }, () => []);

  return <section class="split-chat subagent-pane" aria-label={`Subagent conversation: ${props.target.name}`} oncapture:focus={props.onActivate} oncapture:pointerdown={props.onActivate}>
    <header class="split-pane-header"><span><strong>{props.target.name}</strong></span><button type="button" class="split-pane-close" aria-label="Close subagent conversation" onClick={props.onClose}><X size={15} /></button></header>
    {archived() && <div class="split-pane-status" role="status">This conversation is archived and read-only. <button type="button" onClick={props.onShowArchive}>Open archived sessions to restore it</button></div>}
    {error() && <div class="subagent-pane-error" role="alert">{error()} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
    {!loaded() && !error() && <div class="split-pane-status" role="status">Loading conversation…</div>}
    {loaded() && <ChatView transport={transport} state={session.state} messages={session.messages} debug={props.debug} readOnly controlsDisabled models={[]} commands={[]} thinkingLevels={[]} widgets={[]} statuses={{}} onActivate={props.onActivate} onSend={noop} onAbort={noop} onPause={noop} onResume={noop} onOpenProject={noop} onBranch={noop} onModel={noop} onToggleFastMode={noop} onThinking={noop} />}
  </section>;
}
