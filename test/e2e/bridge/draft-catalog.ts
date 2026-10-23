// Public provider command response used by the isolated UI tests before a conversation starts.
export const draftCatalog = {
  config: { agents: [
    { name: "general", isDefault: true, model: "e2e/acceptance", effort: "high", path_systemprompt: "", path_agent_prompt: "", tools: [], skills: [], mcpServers: {} },
    { name: "reviewer", model: "e2e/acceptance", effort: "off", path_systemprompt: "", path_agent_prompt: "", tools: [], skills: [], mcpServers: {} },
  ] },
  models: [
    { provider: "e2e", id: "acceptance", name: "Acceptance model", reasoning: true },
    { provider: "e2e", id: "alternate", name: "Alternate model", reasoning: true },
  ],
  commands: ["fast"],
  initialModel: null, initialThinking: 'medium',
  commandDetails: [],
};
