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

// A plugin's settings page sees and changes only its own settings.
export interface PluginSettingsProps { settings: Record<string, unknown>; agents: AgentProfile[]; models: Model[]; onChange: (patch: Record<string, unknown>) => void }

export interface PluginSettingsPage { label: string; description: string; icon: (props: LucideProps) => JSX.Element; component: Component<PluginSettingsProps> }

// What a plugin's client.mjs exports. Each part is optional.
// createPlugin: starts the plugin in a conversation; the plugin stops when its owner is disposed.
// settings: the plugin's page in the settings of its host.
// messages: the views of the plugin's custom messages, by custom type.
export interface PluginModule {
  createPlugin?: (context: PluginContext) => PluginInstance;
  settings?: PluginSettingsPage;
  messages?: Record<string, Component<{ details: unknown }>>;
}

export interface SidepaneOpening { requestId: string; initialPrompt?: string; initialImages?: ImageAttachment[]; background: boolean }
