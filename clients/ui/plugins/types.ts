import type { Accessor, Component, JSX } from "solid-js";
import type { LucideProps } from "lucide-solid";
import type { AgentProfile, AgentState, AppSettings, ChatMessage, ImageAttachment, RpcCommand, SessionSummary } from "../types";

export interface PluginConversation { title: string; hostId: string; sessionId: string; messageCount?: number; messages: ChatMessage[]; follow?: () => Accessor<PluginConversation>; readMessages?: () => ChatMessage[]; selected?: { text: string; source: string } }

export interface TranscriptProps { messages: Accessor<HTMLElement | null>; source: Accessor<PluginConversation> }

export interface PluginContext {
  source: Accessor<PluginConversation>;
  visible: Accessor<boolean>;
  activate: () => void;
}

export interface ComposerToolProps { disabled: boolean; compact?: boolean; onText: (text: string) => void }

export interface PluginInstance {
  composer?: Component<ComposerToolProps>;
  panel?: () => JSX.Element;
  show?: () => void;
  transcript?: Component<TranscriptProps>;
}

export interface PluginModule { createPlugin: (context: PluginContext) => PluginInstance }

export interface PluginSettingsProps { settings: AppSettings; agents: AgentProfile[]; onChange: (patch: Partial<AppSettings>) => void }

/** Plugin settings: a tab of their own, or with "within" a sub-tab of a core settings tab such as "agents". */
export interface PluginSettingsSection { section: string; label: string; description: string; icon: (props: LucideProps) => JSX.Element; within?: "agents"; load: () => Promise<{ default: Component<PluginSettingsProps> }> }

export type PluginScope = "client" | "host" | "conversation";

export interface SplitPaneControls { state: Accessor<AgentState>; messages: Accessor<ChatMessage[]>; paneKey: Accessor<string>; connected: Accessor<boolean>; busy: Accessor<boolean>; reportError: (cause: unknown) => void }

export interface SplitPaneRequest { requestId: string; readOnly: boolean; initialPrompt?: string; initialImages?: ImageAttachment[]; actions?: Component<SplitPaneControls>; notice?: Component<{ onShowArchive: () => void }> }

export interface SplitPaneParent { connectionTarget: () => { sessionId?: string }; command: (command: RpcCommand) => Promise<unknown> }

export interface SplitPaneRequestHandler {
  title: string;
  command: string;
  commands: string[];
  rejectInSplit: string;
  open: (request: { id: string; placeholder?: string }, options: { activeHostId: string; pendingImages?: ImageAttachment[]; parent: SplitPaneParent }) => { session: SessionSummary; request: SplitPaneRequest };
}

export interface PluginDefinition {
  id: string;
  scope: PluginScope;
  retainOnHostRestart?: boolean;
  name: string;
  description: string;
  load: () => Promise<PluginModule>;
  settings?: PluginSettingsSection;
  splitPane?: SplitPaneRequestHandler;
  messages?: Record<string, () => Promise<{ default: Component<{ details: unknown }> }>>;
}
