import type { AgentResources } from "./resources.ts";
import type { Agent, AgentSnapshot, SessionAgentState } from "./contracts.ts";
import { DEFAULT_PROMPT_PATH, DEFAULT_AGENT_PROMPT_PATH, resolvePromptPath } from "./prompts.ts";
import type { Config } from "./index.ts";

const development = process.env.PIOP_STORAGE_DIRECTORY === ".piop-dev";

export const fallbackConfig: Config = { agents: [{ name: "general", model: "", effort: development ? "medium" : "high", fastMode: development ? false : undefined, path_systemprompt: DEFAULT_PROMPT_PATH, path_agent_prompt: DEFAULT_AGENT_PROMPT_PATH, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], skills: [], mcpServers: {} }] };

export function copySnapshot(stored: AgentSnapshot | undefined) {
  if (stored?.version !== 1 && stored?.version !== 2) return undefined;

  if (!stored.definition || !Array.isArray(stored.definition.tools)) return undefined;
  return structuredClone(stored);
}

export async function selectedProfileState(agent: Agent, resources: AgentResources, readPrompt: (path: string) => Promise<string>): Promise<SessionAgentState> {
  const definition = structuredClone(agent);
  definition.model = definition.model.trim();
  const agentPromptPath = definition.path_agent_prompt;
  const [systemPrompt, agentPrompt] = await Promise.all([readPrompt(resolvePromptPath(definition.path_systemprompt)), agentPromptPath ? readPrompt(resolvePromptPath(agentPromptPath)) : Promise.resolve("")]);

  return { active: definition.name, locked: false, snapshot: { version: 1, resources: structuredClone(resources), definition, systemPrompt, agentPrompt } };
}
