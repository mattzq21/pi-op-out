import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RuntimeEventSender = (name: string, data: unknown) => Promise<void>;

/**
 * Reports the tools that this Pi offers to its Piop host when the session is ready.
 * Tools that one agent adds, from its MCP servers or its own extensions, stay out: other agents cannot use them.
 */
export function registerToolInventory(pi: ExtensionAPI) {
  const agentSources = new Set([process.env.PI_DESKTOP_DEFINED_AGENTS_EXTENSION, process.env.PIOP_MCP_EXTENSION].filter((path): path is string => Boolean(path)));

  pi.events.on("piop:rpc", request => {
    if (request.command !== "session_ready") return;
    const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as RuntimeEventSender | undefined;

    if (!send) throw new Error("Piop runtime events are unavailable");
    const tools = pi.getAllTools()
      .filter(tool => !agentSources.has(tool.sourceInfo.path))
      .map(tool => ({ name: tool.name, description: tool.description ?? "", source: tool.sourceInfo.path }));
    void send("tools_available", { tools }).catch(error => console.error(`Piop could not save the tools of this Pi: ${error instanceof Error ? error.message : String(error)}`));
  });
}
