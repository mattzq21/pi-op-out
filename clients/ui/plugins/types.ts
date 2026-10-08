import type { Accessor, Component, JSX } from "solid-js";
import type { ChatMessage, GitDiffSnapshots } from "../types";

export interface PluginConversation { title: string; hostId: string; sessionId: string; messageCount?: number; messages: ChatMessage[]; gitDiffs?: GitDiffSnapshots; follow?: () => Accessor<PluginConversation>; readMessages?: () => ChatMessage[]; selected?: { text: string; source: string } }

export interface TranscriptProps { messages: Accessor<HTMLElement | null>; source: Accessor<PluginConversation> }

export interface PluginContext {
  source: Accessor<PluginConversation>;
  visible: Accessor<boolean>;
  activate: () => void;
}

export interface PluginInstance {
  panel: () => JSX.Element;
  show?: () => void;
  transcript?: Component<TranscriptProps>;
}

export interface PluginModule { createPlugin: (context: PluginContext) => PluginInstance }
