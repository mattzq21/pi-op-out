import type { McpServer } from "./mcp-config.ts";

export type Agent = { name: string; model: string; effort: string; fastMode?: boolean; extensions?: string[]; path_systemprompt: string; path_agentprompt: string; tools: string[]; skills: string[]; mcpServers: McpServer[] };

export type AgentSnapshot = { version: 2; definition: Agent } | { version: 1; definition: Agent; systemPrompt: string; agentPrompt: string };

export type SessionAgentState = { snapshot?: AgentSnapshot; active?: string; locked?: boolean; modelOverride?: string; effortOverride?: string; fastModeOverride?: boolean | null };

export interface SubagentProfileRequest { agent?: string; state?: SessionAgentState; error?: string }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:agents:subagent", handler: (request: SubagentProfileRequest) => void): () => void;
    emit(channel: "piop:agents:subagent", request: SubagentProfileRequest): void;
  }
}
