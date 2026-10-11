import type { McpServers } from "./mcp-config.ts";
import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface RuntimeSettingsRequest { settings?: { defaultModel?: string; tools: string[]; skills: string[]; explicitOnlySkills?: string[] } }

export interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; availableTools?: string[] }

export interface McpToolsRequest { tools?: string[]; availableTools?: string[] }

export interface McpSelection { codemode?: boolean; servers: McpServers; agentName: string; sessionId: string; registered?: Promise<string[]> }

export interface AgentRefreshRequest { ctx: ExtensionContext; ready?: Promise<void> }

export interface AgentReloadRequest { ctx: ExtensionCommandContext; ready?: Promise<void> }

interface FastModeChange { enabled?: boolean; ready?: Promise<void> }

interface FastModelsChange { ctx: ExtensionContext }

export type Agent = { name: string; model: string; effort: string; fastMode?: boolean; codemode?: boolean; extensions?: string[]; max_subagents?: number; max_sub_subagents?: number; path_systemprompt: string; path_agent_prompt: string; tools: string[]; skills: string[]; mcpServers: McpServers };

export type AgentSnapshot = { version: 2; definition: Agent } | { version: 1; definition: Agent; systemPrompt: string; agentPrompt: string };

export type SessionAgentState = { snapshot?: AgentSnapshot; active?: string; locked?: boolean; modelOverride?: string; effortOverride?: string; fastModeOverride?: boolean | null };

export interface SubagentProfileRequest { agent?: string; state?: SessionAgentState; error?: string; ready?: Promise<void> }

export interface AgentProfileSummary { name: string; model: string; effort: string; fastMode?: boolean; max_subagents?: number; max_sub_subagents?: number; tools: string[]; skills: string[]; mcpServers: string[]; path_systemprompt: string; path_agent_prompt: string }

export interface SubagentLimitsRequest { max_subagents?: number; max_sub_subagents?: number }

export interface AgentProfilesRequest { active?: string; profiles?: AgentProfileSummary[] }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:subagent-limits", handler: (request: SubagentLimitsRequest) => void): () => void;
    emit(channel: "piop:agents:subagent-limits", request: SubagentLimitsRequest): void;
    on(channel: "piop:agents:profiles", handler: (request: AgentProfilesRequest) => void): () => void;
    emit(channel: "piop:agents:profiles", request: AgentProfilesRequest): void;
    on(channel: "piop:agents:subagent", handler: (request: SubagentProfileRequest) => void): () => void;
    emit(channel: "piop:agents:subagent", request: SubagentProfileRequest): void;
    on(channel: "piop:agents:refresh", handler: (request: AgentRefreshRequest) => void): () => void;
    emit(channel: "piop:agents:refresh", request: AgentRefreshRequest): void;
    on(channel: "piop:agents:reload", handler: (request: AgentReloadRequest) => void): () => void;
    emit(channel: "piop:agents:reload", request: AgentReloadRequest): void;
    on(channel: "piop:fast-mode-changed", handler: (event: FastModeChange) => void): () => void;
    emit(channel: "piop:fast-mode-changed", event: FastModeChange): void;
    on(channel: "piop:fast-mode-models-changed", handler: (event: FastModelsChange) => void): () => void;
    emit(channel: "piop:fast-mode-models-changed", event: FastModelsChange): void;
  }
}
