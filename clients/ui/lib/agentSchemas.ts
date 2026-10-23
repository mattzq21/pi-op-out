import { z } from "zod";

import { mcpServersSchema } from "../../../extensions/piop-define-agents/mcp-schema";
import { MAX_CAP, MIN_CAP } from "../../../extensions/piop-context-window-cap/interface";

export { mcpServerSchema, mcpServersSchema } from "../../../extensions/piop-define-agents/mcp-schema";

const agentAccessSchema = z.union([z.literal("all"), z.literal("none"), z.array(z.string())]);

export const agentProfileSchema = z.object({
  max_subagents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), max_sub_subagents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  allow_as_subagent: z.boolean().optional(), allow_as_peer: z.boolean().optional(), allowed_subagents: agentAccessSchema.optional(), allowed_peers: agentAccessSchema.optional(),
  name: z.string(), description: z.string().optional(), isDefault: z.boolean().optional(), model: z.string(), effort: z.string(), fastMode: z.boolean().optional(), contextWindowCap: z.number().int().min(MIN_CAP).max(MAX_CAP).nullable().optional(), codemode: z.enum(["on", "off"]).optional(), extensions: z.array(z.string()).optional(),
  path_systemprompt: z.string(), path_agent_prompt: z.string(), tools: z.array(z.string()), skills: z.array(z.string()),
  mcpServers: mcpServersSchema,
});

export const agentConfigSchema = z.object({ revision: z.string().optional(), agents: z.array(agentProfileSchema) });

export const agentConfigChangeSchema = z.object({ revision: z.string(), warnings: z.array(z.string()).optional() });

export const definedAgentsCapabilitySchema = z.object({
  version: z.number().default(1), active: z.string(), locked: z.boolean().optional(), saved: z.boolean().optional(),
  unavailable: z.boolean().optional(), config: agentConfigSchema,
});
