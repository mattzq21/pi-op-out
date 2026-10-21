import type { Config, ConfigStorage } from "./index.ts";

export async function migrateExcalidrawAgent(config: Config, storage: ConfigStorage) {
  if (config.excalidrawAgentDefaultApplied) return false;

  if (!config.agents.some(agent => agent.name === "excalidraw-agent")) {
    const path = "sysprompt/excalidraw-agent.md";
    const skill = `~/${process.env.PIOP_STORAGE_DIRECTORY || ".piop"}/piop-excalidraw/SKILL.md`;
    await storage.ensurePromptFile(path, `You are excalidraw-agent. Create and refine diagrams using the Excalidraw MCP tools. Before drawing, read the bundled skill at ${skill} and its references/cheatsheet.md as needed. Use MCP tools directly; your read tool is for skill files and source material supplied by the user. Describe the existing scene before editing, preserve unrelated elements, and inspect screenshots to refine layout. The live canvas is http://127.0.0.1:3000; share that link with the user. Screenshots, image export, Mermaid conversion, and viewport control require the canvas to be open in a browser tab on the agent's host. If a tool reports that a tab is required, ask the user to open the canvas and continue once it is available. Do not claim visual verification without a screenshot. Export an editable .excalidraw file when requested.`);
    config.agents.push({
      name: "excalidraw-agent", model: "", effort: "high", codemode: "off",
      path_systemprompt: path, path_agent_prompt: "", tools: ["read"], skills: [],
      mcpServers: { excalidraw: { command: "npx", args: ["-y", "mcp-excalidraw-server@2.0.0"], enabled: true, timeout: 120 } },
    });
  }

  config.excalidrawAgentDefaultApplied = true;

  return true;
}
