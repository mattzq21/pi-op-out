import { z } from "zod";

import { mcpServersSchema } from "../../extensions/piop-define-agents/mcp-schema";

export { mcpServerSchema, mcpServersSchema } from "../../extensions/piop-define-agents/mcp-schema";

export const agentProfileSchema = z.object({
  name: z.string(), model: z.string(), effort: z.string(), fastMode: z.boolean().optional(), codemode: z.boolean().optional(), extensions: z.array(z.string()).optional(),
  path_systemprompt: z.string(), path_agent_prompt: z.string(), tools: z.array(z.string()), skills: z.array(z.string()),
  mcpServers: mcpServersSchema,
});

export const agentConfigSchema = z.object({ agents: z.array(agentProfileSchema), fastModeModels: z.array(z.string()).optional() });

export const definedAgentsCapabilitySchema = z.object({
  version: z.number().default(1), active: z.string(), locked: z.boolean().optional(), saved: z.boolean().optional(),
  unavailable: z.boolean().optional(), config: agentConfigSchema,
});
