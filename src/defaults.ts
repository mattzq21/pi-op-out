import type { AppSettings } from "./types";
import { defaultKeybindings } from "./lib/keybindings";

export const defaultSettings: AppSettings = {
  defaultModel: "openrouter/deepseek/deepseek-v4-flash", defaultThinking: "high",
  contextWindowCap: 200_000, autoCompaction: true, autoRetry: true,
  keybindings: { ...defaultKeybindings },
  tools: [
    { name: "read", description: "Read files from the active project", enabled: true, builtin: true },
    { name: "bash", description: "Run shell commands", enabled: true, builtin: true },
    { name: "edit", description: "Apply targeted edits", enabled: true, builtin: true },
    { name: "write", description: "Create and overwrite files", enabled: true, builtin: true },
    { name: "grep", description: "Search file contents", enabled: true, builtin: true },
    { name: "find", description: "Find files by glob", enabled: true, builtin: true },
    { name: "ls", description: "List directories", enabled: true, builtin: true },
    { name: "list_agents", description: "List agents by machine and session", enabled: true, builtin: false },
    { name: "send_message", description: "Send a message to another agent", enabled: true, builtin: false }
  ],
  skills: [],
  hosts: [],
  mcpServers: [
    { id: "filesystem", name: "Filesystem", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-filesystem .", enabled: true, status: "connected" }
  ]
};
