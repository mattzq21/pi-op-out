import { z } from "zod";

const mcpExposure = z.enum(["direct", "deferred", "codemode", "codemode-deferred", "hidden"]);

export const mcpServerSchema = z.object({
  command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(),
  url: z.string().url().optional(), headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(), timeout: z.number().positive().optional(), description: z.string().optional(),
  exposure: mcpExposure.optional(), toolExposure: z.record(z.string(), mcpExposure).optional(),
}).passthrough().refine(value => Boolean(value.command?.trim() || value.url), "Each MCP server needs a command or URL");

export const mcpServersSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/, "Use letters, digits, underscores or hyphens for server names"), mcpServerSchema)
  .refine(value => new Set(Object.keys(value).map(name => name.replaceAll("-", "_"))).size === Object.keys(value).length, "MCP server names must not differ only by hyphens and underscores");

export const agentProfileSchema = z.object({
  name: z.string(), model: z.string(), effort: z.string(), fastMode: z.boolean().optional(), extensions: z.array(z.string()).optional(),
  path_systemprompt: z.string(), path_agentprompt: z.string(), tools: z.array(z.string()), skills: z.array(z.string()),
  mcpServers: mcpServersSchema,
});

export const agentConfigSchema = z.object({ agents: z.array(agentProfileSchema), fastModeModels: z.array(z.string()).optional() });

export const definedAgentsCapabilitySchema = z.object({
  version: z.number().default(1), active: z.string(), locked: z.boolean().optional(), saved: z.boolean().optional(),
  unavailable: z.boolean().optional(), config: agentConfigSchema,
});
