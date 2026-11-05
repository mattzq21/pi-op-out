// The tools that start and manage subagents. Their results carry the subagents' runs, which clients show as icons.
export const SUBAGENT_TOOLS = ["spawn_subagents", "message_subagent", "stop_subagent", "list_subagents", "await_subagents"];

export const showsSubagents = (toolName?: string) => toolName !== undefined && SUBAGENT_TOOLS.includes(toolName);
