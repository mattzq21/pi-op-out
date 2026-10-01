import { z } from "zod";

export const mcpServerSchema = z.object({
  id: z.string(), name: z.string(), transport: z.enum(["stdio", "http"]).optional(),
  command: z.string().default(""), args: z.string().default(""), url: z.string().optional(), headers: z.string().optional(),
  enabled: z.boolean(), startupTimeoutSec: z.number().optional(), injectAgentId: z.boolean().optional(),
  status: z.enum(["starting", "connected", "stopped", "error"]).optional(), error: z.string().optional(),
});

export const agentProfileSchema = z.object({
  name: z.string(), model: z.string(), effort: z.string(), fastMode: z.boolean().optional(), extensions: z.array(z.string()).optional(),
  path_systemprompt: z.string(), path_agentprompt: z.string(), tools: z.array(z.string()), skills: z.array(z.string()),
  mcpServers: z.array(mcpServerSchema),
});

export const agentConfigSchema = z.object({ agents: z.array(agentProfileSchema), fastModeModels: z.array(z.string()).optional() });

export const definedAgentsCapabilitySchema = z.object({
  version: z.number().default(1), active: z.string(), locked: z.boolean().optional(), saved: z.boolean().optional(),
  unavailable: z.boolean().optional(), config: agentConfigSchema,
});
