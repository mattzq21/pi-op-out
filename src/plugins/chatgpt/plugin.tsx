import { createSignal, Show } from "solid-js";
import { QuickChat } from "./QuickChat";
import { captureChatGptContext, chatGptContext, type ChatGptContextSource } from "./context";
import { ChatGptSelection } from "./ChatGptSelection";
import type { QuickChatRequest } from "./useChatGpt";
import type { PluginContext, PluginInstance } from "../types";

export function createPlugin(context: PluginContext): PluginInstance {
  const [request, setRequest] = createSignal<QuickChatRequest>();

  const start = async (value?: ChatGptContextSource, signal = new AbortController().signal) => {
    const selected = value?.selected;
    const current = context.source();
    const otherPane = value && (value.hostId !== current.hostId || value.sessionId !== current.sessionId);
    const prepared = otherPane ? { ...value, preparedContext: await chatGptContext(value, signal) } : undefined;
    signal.throwIfAborted();
    const [initialSource, setInitialSource] = createSignal(prepared);
    const readSource = () => ({ ...context.source(), selected });
    setRequest({ id: crypto.randomUUID(), hostId: value?.hostId ?? current.hostId,
      source: () => initialSource() ?? captureChatGptContext(readSource), onAccepted: () => setInitialSource(undefined) });
    context.activate();
  };

  return {
    transcript: props => <ChatGptSelection {...props} onAsk={start} />,
    show: () => { if (!request()) start(); },
    panel: () => <Show when={request()}><QuickChat request={request()} open={context.visible()} onNew={() => start()} /></Show>,
  };
}
