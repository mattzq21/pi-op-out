import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Agent, RuntimeSettingsRequest, SessionAgentState } from "./contracts.ts";
import { resolvePromptPath } from "./prompts.ts";

export async function selectedProfileState(pi: ExtensionAPI, agent: Agent, readPrompt: (path: string) => Promise<string>): Promise<SessionAgentState> {
  const definition = structuredClone(agent);
  const defaults: RuntimeSettingsRequest = {};
  pi.events.emit("piop:runtime-settings", defaults);
  definition.model = definition.model.trim() || defaults.settings?.defaultModel || "";
  const [systemPrompt, agentPrompt] = await Promise.all([readPrompt(resolvePromptPath(definition.path_systemprompt)), definition.path_agentprompt ? readPrompt(resolvePromptPath(definition.path_agentprompt)) : Promise.resolve("")]);

  return { active: definition.name, locked: false, snapshot: { version: 1, definition, systemPrompt, agentPrompt } };
}
