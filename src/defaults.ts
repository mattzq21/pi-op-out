import type { AppSettings } from "./types";
import { defaultKeybindings } from "./lib/keybindings";

export const defaultSettings: AppSettings = {
  theme: "system", defaultModel: "openrouter/deepseek/deepseek-v4-flash", defaultThinking: "high",
  autoCompaction: true, autoRetry: true, notifications: true,
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  keybindings: { ...defaultKeybindings },
  tools: [
    { name: "read", description: "Read files from the active project", enabled: true, builtin: true },
    { name: "bash", description: "Run shell commands", enabled: true, builtin: true },
    { name: "edit", description: "Apply targeted edits", enabled: true, builtin: true },
    { name: "write", description: "Create and overwrite files", enabled: true, builtin: true },
    { name: "grep", description: "Search file contents", enabled: true, builtin: true },
    { name: "find", description: "Find files by glob", enabled: true, builtin: true },
    { name: "ls", description: "List directories", enabled: true, builtin: true }
  ],
  skills: [],
  mcpServers: [
    { id: "filesystem", name: "Filesystem", command: "npx", args: "-y @modelcontextprotocol/server-filesystem .", enabled: true, status: "connected" }
  ]
};
