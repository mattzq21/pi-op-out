import type { AgentResources } from "./resources.ts";
import type { McpServers } from "./mcp-config.ts";
import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface AppRequest { command: string; payload: unknown; ctx: ExtensionCommandContext; ready?: Promise<unknown> }

export interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; withheldTools: string[]; availableTools?: string[] }

export interface McpToolsRequest { tools?: string[]; availableTools?: string[] }

export type CodemodeChoice = "on" | "off";

export interface McpSelection { codemode?: CodemodeChoice; servers: McpServers; sessionId: string; registered?: Promise<string[]> }

export type AgentAccess = "all" | "none" | string[];

export type AgentStartPurpose = "subagent" | "peer";

export type Agent = { unavailableReason?: string; project?: boolean; name: string; description?: string; isDefault?: boolean; model: string; effort: string; fastMode?: boolean; contextWindowCap?: number | null; codemode?: CodemodeChoice; extensions?: string[]; max_subagents?: number; allow_as_subagent?: boolean; allow_as_peer?: boolean; allowed_subagents?: AgentAccess; allowed_peers?: AgentAccess; path_systemprompt: string; path_agent_prompt: string; tools: string[]; skills: string[]; mcpServers: McpServers };

export type AgentSnapshot = ({ version: 2; definition: Agent } | { version: 1; definition: Agent; systemPrompt: string; agentPrompt: string }) & { resources?: AgentResources };

export type SessionAgentState = { snapshot?: AgentSnapshot; active?: string; locked?: boolean; modelOverride?: string; effortOverride?: string };

export interface SubagentProfileRequest { agent?: string; purpose?: AgentStartPurpose; state?: SessionAgentState; error?: string; ready?: Promise<void> }

export interface AgentProfileSummary { name: string; description?: string }

export interface SubagentLimitsRequest { max_subagents?: number }

export interface AgentProfilesRequest { purpose: AgentStartPurpose; active?: string; profiles?: AgentProfileSummary[] }

export interface AgentContextCapRequest { cap?: number | null }

export interface AgentSelectedEvent { ctx: ExtensionContext }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:rpc", handler: (request: AppRequest) => void): () => void;
    emit(channel: "piop:rpc", request: AppRequest): void;
    on(channel: "piop:agents:context-cap", handler: (request: AgentContextCapRequest) => void): () => void;
    emit(channel: "piop:agents:context-cap", request: AgentContextCapRequest): void;
    on(channel: "piop:agents:selected", handler: (event: AgentSelectedEvent) => void): () => void;
    emit(channel: "piop:agents:selected", event: AgentSelectedEvent): void;
    on(channel: "piop:agents:subagent-limits", handler: (request: SubagentLimitsRequest) => void): () => void;
    emit(channel: "piop:agents:subagent-limits", request: SubagentLimitsRequest): void;
    on(channel: "piop:agents:profiles", handler: (request: AgentProfilesRequest) => void): () => void;
    emit(channel: "piop:agents:profiles", request: AgentProfilesRequest): void;
    on(channel: "piop:agents:subagent", handler: (request: SubagentProfileRequest) => void): () => void;
    emit(channel: "piop:agents:subagent", request: SubagentProfileRequest): void;
  }
}
