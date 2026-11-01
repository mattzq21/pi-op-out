import { z } from "zod";
import { decodeAgentValue } from "./agentProtocol";
import { hostCatalog } from "./draftRuntime";
import { nativeCall } from "./nativeCall";
import { listen } from "./platform";
import type { AgentConfig, DefinedAgentsCapability } from "../types";

/** What a chat reports about its own agent. The list of agents comes from the host. */
const agentStatusSchema = z.object({ version: z.number().default(1), active: z.string(), locked: z.boolean().optional(), saved: z.boolean().optional(), unavailable: z.boolean().optional() });

const savedSchema = z.object({ revision: z.string(), warnings: z.array(z.string()) });

/** Saves the host's agent definitions. The host checks them as a new agent would start, and refuses them when another window saved first. */
export function saveAgentDefinitions(hostId: string, configuration: AgentConfig) {
  return nativeCall("save_agent_definitions", { hostId, configuration }, savedSchema);
}

/**
 * Turns a chat's agent status into the agents of its picker: the status with the host's agent list.
 * The list is read again when the host's agent definitions change. A status that cannot be read clears the agents and is reported.
 */
export function agentStatusReader(hostId: () => string, publish: (capability: DefinedAgentsCapability | undefined) => void, fail: (reason: unknown) => void) {
  let statusText: string | undefined;
  let sequence = 0;
  let closed = false;

  const read = (fresh: boolean) => {
    const current = ++sequence;

    if (!statusText?.startsWith("json:")) { publish(undefined); return; }
    let status: z.output<typeof agentStatusSchema>;

    try { status = agentStatusSchema.parse(decodeAgentValue(statusText.slice(5))); }
    catch (reason) { publish(undefined); fail(reason); return; }

    void hostCatalog(hostId(), fresh ? "fresh" : "cached").then(
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

/** The agent definitions were saved, but the settings save after them failed. */
export class AgentsSavedError extends Error {
  constructor(cause: unknown) {
    super(`Agent definitions were saved, but the settings were not: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "AgentsSavedError";
  }
}
