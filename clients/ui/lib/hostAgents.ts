import { z } from "zod";
import { decodeAgentValue } from "./agentProtocol";
import { hostCatalog } from "./draftRuntime";
import { nativeCall } from "./nativeCall";
import { listen } from "./platform";
import type { AgentConfig, AgentProfile, DefinedAgentsCapability } from "../types";

const agentStatusSchema = z.object({ version: z.number().default(1), active: z.string(), locked: z.boolean().optional(), saved: z.boolean().optional(), unavailable: z.boolean().optional() });

const savedSchema = z.object({ revision: z.string(), warnings: z.array(z.string()) });

export function saveAgentDefinitions(hostId: string, configuration: AgentConfig) {
  return nativeCall("save_agent_definitions", { hostId, configuration }, savedSchema);
}

export type ProjectAgentsChange = { revision: string; agents?: AgentProfile[]; defaultAgent?: string | null };

export function saveProjectAgents(hostId: string, cwd: string, configuration: ProjectAgentsChange) {
  return nativeCall("save_agent_definitions", { hostId, cwd, configuration }, savedSchema);
}

const promptPreviewSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
  tools: z.array(z.object({ place: z.string(), json: z.string() })),
  notices: z.array(z.string()).optional(),
});

export type PromptPreview = z.output<typeof promptPreviewSchema>;

export function previewAgentPrompt(hostId: string, agent: string, cwd?: string) {
  return nativeCall("agent_prompt_preview", { hostId, agent, ...(cwd ? { cwd } : {}) }, promptPreviewSchema);
}

export function moveAgent(hostId: string, agent: string, revision: string, from: string | null, to: string | null) {
  return nativeCall("move_agent", { hostId, agent, revision, ...(from ? { from } : {}), ...(to ? { to } : {}) }, savedSchema);
}

export function agentStatusReader(hostId: () => string, cwd: () => string | undefined, publish: (capability: DefinedAgentsCapability | undefined) => void, fail: (reason: unknown) => void) {
  let statusText: string | undefined;
  let sequence = 0;
  let closed = false;

  const read = (fresh: boolean) => {
    const current = ++sequence;

    if (!statusText?.startsWith("json:")) { publish(undefined); return; }
    let status: z.output<typeof agentStatusSchema>;

    try { status = agentStatusSchema.parse(decodeAgentValue(statusText.slice(5))); }
    catch (reason) { publish(undefined); fail(reason); return; }

    void hostCatalog(hostId(), fresh ? "fresh" : "cached", cwd()).then(
      ({ config }) => { if (!closed && current === sequence) publish({ ...status, config }); },
      reason => { if (!closed && current === sequence) { publish({ ...status, config: { agents: [] } }); fail(reason); } },
    );
  };

  const stop = listen("pi://agent-definitions-changed", ({ payload }) => { if (!closed && statusText !== undefined && payload.hostId === hostId()) read(true); }, z.object({ hostId: z.string() }));
  void stop.catch(fail);

  return {
    receive(text: string | undefined) { statusText = text; read(false); },
    close() { closed = true; void stop.then(unlisten => unlisten(), () => undefined); },
  };
}

export class AgentsSavedError extends Error {
  constructor(cause: unknown) {
    super(`Agent definitions were saved, but the settings were not: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "AgentsSavedError";
  }
}
