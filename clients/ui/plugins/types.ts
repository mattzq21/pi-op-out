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

export interface PluginSettingsProps { settings: AppSettings; agents: AgentProfile[]; models: Model[]; onChange: (patch: Partial<AppSettings>) => void }

export interface PluginSettingsSection { section: string; label: string; description: string; icon: (props: LucideProps) => JSX.Element; load: () => Promise<{ default: Component<PluginSettingsProps> }> }

export type PluginScope = "client" | "host" | "conversation";

export interface SidepaneOpening { requestId: string; initialPrompt?: string; initialImages?: ImageAttachment[] }

export interface PluginDefinition {
  id: string;
  scope: PluginScope;
  retainOnHostRestart?: boolean;
  name: string;
  description: string;
  load?: () => Promise<PluginModule>;
  settings?: PluginSettingsSection;
  queuedCommands?: string[];
  messages?: Record<string, () => Promise<{ default: Component<{ details: unknown }> }>>;
}
