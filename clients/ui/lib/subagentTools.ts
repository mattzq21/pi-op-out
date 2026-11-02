const SUBAGENT_TOOLS = new Set(["spawn_subagents", "await_subagents", "message_subagent", "list_subagents", "stop_subagent"]);

export const showsSubagents = (toolName?: string) => toolName !== undefined && SUBAGENT_TOOLS.has(toolName);
