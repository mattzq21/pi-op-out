import type { McpServer } from "./mcp-config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface RuntimeSettingsRequest { settings?: { tools: string[]; skills: string[]; explicitOnlySkills?: string[] } }

export interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[] }

export interface McpToolsRequest { tools?: string[] }

export interface McpSelection { servers: McpServer[]; agentName: string; sessionId: string; ready?: Promise<string[]> }

export interface AgentRefreshRequest { ctx: ExtensionContext; ready?: Promise<void> }

interface FastModeChange { enabled?: boolean }

interface FastModelsChange { ctx: ExtensionContext }

export type Agent = { name: string; model: string; effort: string; fastMode?: boolean; extensions?: string[]; path_systemprompt: string; path_agentprompt: string; tools: string[]; skills: string[]; mcpServers: McpServer[] };

export type AgentSnapshot = { version: 2; definition: Agent } | { version: 1; definition: Agent; systemPrompt: string; agentPrompt: string };

export type SessionAgentState = { snapshot?: AgentSnapshot; active?: string; locked?: boolean; modelOverride?: string; effortOverride?: string; fastModeOverride?: boolean | null };

export interface SubagentProfileRequest { agent?: string; state?: SessionAgentState; error?: string }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:subagent", handler: (request: SubagentProfileRequest) => void): () => void;
    emit(channel: "piop:agents:subagent", request: SubagentProfileRequest): void;
    on(channel: "piop:agents:refresh", handler: (request: AgentRefreshRequest) => void): () => void;
    emit(channel: "piop:agents:refresh", request: AgentRefreshRequest): void;
    on(channel: "piop:fast-mode-changed", handler: (event: FastModeChange) => void): () => void;
    emit(channel: "piop:fast-mode-changed", event: FastModeChange): void;
    on(channel: "piop:fast-mode-models-changed", handler: (event: FastModelsChange) => void): () => void;
    emit(channel: "piop:fast-mode-models-changed", event: FastModelsChange): void;
  }
}
