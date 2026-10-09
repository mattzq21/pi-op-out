import { createContext, For, useContext, type Accessor, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AgentState, ChatMessage } from "../types";
import type { PluginConversation, TranscriptProps } from "./types";

export const TranscriptPluginsContext = createContext<Accessor<Component<TranscriptProps>[]>>();

export function conversationSource(host: Accessor<string>, session: Accessor<{ state: AgentState; messages: ChatMessage[] }>): Accessor<PluginConversation> {
  return () => ({ hostId: host(), sessionId: session().state.sessionId, title: session().state.sessionName || "Current conversation", messageCount: session().state.messageCount, messages: [...session().messages] });
}

export function TranscriptPlugins(props: TranscriptProps) {
  const extensions = useContext(TranscriptPluginsContext);

  return <For each={extensions?.()}>{extension => <Dynamic component={extension} {...props} />}</For>;
}
