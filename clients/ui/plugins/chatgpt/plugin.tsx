import { createSignal, Show } from "solid-js";
import { QuickChat } from "./QuickChat";
import { captureChatGptContext, chatGptContext, type ChatGptContextSource } from "./context";
import { ChatGptSelection } from "./ChatGptSelection";
import { createChatGptDrafts, type QuickChatRequest } from "./useChatGpt";
import type { PluginContext, PluginInstance } from "../types";

export function createPlugin(context: PluginContext): PluginInstance {
  const [request, setRequest] = createSignal<QuickChatRequest>();
  const drafts = createChatGptDrafts();

  const start = async (value?: ChatGptContextSource, signal = new AbortController().signal) => {
    const selected = value?.selected;
    const current = context.source();
    const otherPane = value && (value.hostId !== current.hostId || value.sessionId !== current.sessionId);
    const prepared = otherPane ? { ...value, preparedContext: await chatGptContext(value, signal) } : value;
    signal.throwIfAborted();
    const [initialSource, setInitialSource] = createSignal(prepared);

    const readSource = () => {
      const source = context.source();
      const sameConversation = source.hostId === value?.hostId && source.sessionId === value?.sessionId;

      return { ...source, selected: sameConversation ? selected : undefined };
    };

    setRequest({ id: crypto.randomUUID(),
      source: () => initialSource() ?? captureChatGptContext(readSource), onAccepted: () => setInitialSource(undefined) });
    context.activate();
  };

  return {
    transcript: props => <ChatGptSelection {...props} onAsk={start} />,
    show: () => { if (!request()) start(); },
    panel: () => <Show when={request()}><QuickChat request={request()} open={context.visible()} onNew={() => start()} drafts={drafts} /></Show>,
  };
}
