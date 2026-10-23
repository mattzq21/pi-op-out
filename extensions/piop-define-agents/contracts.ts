import type { AgentResources } from "./resources.ts";
import type { McpServers } from "./mcp-config.ts";
import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface AppRequest { command: string; payload: unknown; ctx: ExtensionCommandContext; ready?: Promise<unknown> }

export interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; availableTools?: string[] }

export interface McpToolsRequest { tools?: string[]; availableTools?: string[] }

/** Whether an agent has the codemode tool next to its other tools. Missing means on. */
export type CodemodeChoice = "on" | "off";

export interface McpSelection { codemode?: CodemodeChoice; servers: McpServers; sessionId: string; registered?: Promise<string[]> }

/** Which agents an agent may start: all of them, none, or the named ones. Missing means all. */
export type AgentAccess = "all" | "none" | string[];

/** How a session with another agent starts: as a subagent of the caller, or as an independent peer. */
export type AgentStartPurpose = "subagent" | "peer";

/**
 * contextWindowCap: undefined inherits; null selects the model default. isDefault marks the one agent that new root sessions start with.
 * allow_as_subagent and allow_as_peer: false stops other agents from starting this agent that way. Missing means allowed.
 * allowed_subagents and allowed_peers: the agents this agent may start that way.
 */
export type Agent = { name: string; description?: string; isDefault?: boolean; model: string; effort: string; fastMode?: boolean; contextWindowCap?: number | null; codemode?: CodemodeChoice; extensions?: string[]; max_subagents?: number; max_sub_subagents?: number; allow_as_subagent?: boolean; allow_as_peer?: boolean; allowed_subagents?: AgentAccess; allowed_peers?: AgentAccess; path_systemprompt: string; path_agent_prompt: string; tools: string[]; skills: string[]; mcpServers: McpServers };

export type AgentSnapshot = ({ version: 2; definition: Agent } | { version: 1; definition: Agent; systemPrompt: string; agentPrompt: string }) & { resources?: AgentResources };

export type SessionAgentState = { snapshot?: AgentSnapshot; active?: string; locked?: boolean; modelOverride?: string; effortOverride?: string };

/** purpose: set when the profile starts a subagent or peer, so the agent access rules apply. */
export interface SubagentProfileRequest { agent?: string; purpose?: AgentStartPurpose; state?: SessionAgentState; error?: string; ready?: Promise<void> }

export interface AgentProfileSummary { name: string; description?: string }

export interface SubagentLimitsRequest { max_subagents?: number; max_sub_subagents?: number }

/** Lists the agents the current agent can start for purpose. */
export interface AgentProfilesRequest { purpose: AgentStartPurpose; active?: string; profiles?: AgentProfileSummary[] }

/** The current agent's context cap default. cap stays undefined when the agent inherits. */
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
