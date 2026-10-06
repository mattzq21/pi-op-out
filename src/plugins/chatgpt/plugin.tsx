import { createSignal, Show } from "solid-js";
import { QuickChat } from "./QuickChat";
import { captureChatGptContext, type ChatGptContextSource } from "./context";
import { ChatGptSelection } from "./ChatGptSelection";
import type { QuickChatRequest } from "./useChatGpt";
import type { PluginContext, PluginInstance } from "../types";

export function createPlugin(context: PluginContext): PluginInstance {
  const [request, setRequest] = createSignal<QuickChatRequest>();

  const start = (value?: ChatGptContextSource) => {
    const selected = value?.selected;
    const current = context.source();
    const otherPane = value && (value.hostId !== current.hostId || value.sessionId !== current.sessionId);
    const [initialSource, setInitialSource] = createSignal(otherPane ? value : undefined);
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
