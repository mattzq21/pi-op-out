import type { Accessor, Component, JSX } from "solid-js";
import type { LucideProps } from "lucide-solid";
import type { AgentProfile, AgentState, AppSettings, ChatMessage, ImageAttachment, Model, RpcCommand, SessionSummary } from "../types";

export interface PluginConversation { title: string; hostId: string; sessionId: string; messageCount?: number; messages: ChatMessage[]; follow?: () => Accessor<PluginConversation>; readMessages?: () => ChatMessage[]; selected?: { text: string; source: string } }

export interface TranscriptProps { messages: Accessor<HTMLElement | null>; source: Accessor<PluginConversation> }

export interface PluginContext {
  source: Accessor<PluginConversation>;
}

export interface ComposerToolProps { disabled: boolean; compact?: boolean; onText: (text: string) => void }

export interface PluginInstance {
  composer?: Component<ComposerToolProps>;
  transcript?: Component<TranscriptProps>;
}

export interface PluginModule { createPlugin: (context: PluginContext) => PluginInstance }

/** models: the models of the host whose settings are shown. */
export interface PluginSettingsProps { settings: AppSettings; agents: AgentProfile[]; models: Model[]; onChange: (patch: Partial<AppSettings>) => void }

/** Plugin settings: a sub-tab of the Plugins settings tab, shown while the plugin is enabled. */
export interface PluginSettingsSection { section: string; label: string; description: string; icon: (props: LucideProps) => JSX.Element; load: () => Promise<{ default: Component<PluginSettingsProps> }> }

export type PluginScope = "client" | "host" | "conversation";

/** The first prompt of an auxiliary chat that a plugin command opened in the side pane, and the request to answer when the chat opens. */
export interface SidepaneOpening { requestId: string; initialPrompt?: string; initialImages?: ImageAttachment[] }

export interface PluginDefinition {
  id: string;
  scope: PluginScope;
  retainOnHostRestart?: boolean;
  name: string;
  description: string;
  /** The client code. A plugin without it runs only in the daemon and only shows in the plugin list. */
  load?: () => Promise<PluginModule>;
  settings?: PluginSettingsSection;
  /** Slash commands that wait in the follow-up queue like a message. */
  queuedCommands?: string[];
  messages?: Record<string, () => Promise<{ default: Component<{ details: unknown }> }>>;
}
