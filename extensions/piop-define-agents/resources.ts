import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const agentResourcesSchema = Type.Object({
  tools: Type.Object({ enabledTools: Type.Array(Type.String()), registeredTools: Type.Array(Type.String()) }),
  skills: Type.Object({ userInvokedSkills: Type.Array(Type.String()), agentInvokedSkills: Type.Array(Type.String()) }),
});

export type AgentResources = Static<typeof agentResourcesSchema>;

export const resourcePath = (path: string) => resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export function parseAgentResources(value: unknown): AgentResources {
  if (!Check(agentResourcesSchema, value)) throw new Error("Invalid agent startup resources");
  const registered = new Set(value.tools.registeredTools);
  if (value.tools.enabledTools.some(tool => !registered.has(tool))) throw new Error("An enabled tool is not registered");
  const user = new Set(value.skills.userInvokedSkills.map(resourcePath));
  if (value.skills.agentInvokedSkills.some(skill => user.has(resourcePath(skill)))) throw new Error("A skill cannot be both user invoked and agent invoked");
  return structuredClone(value);
}

export function readAgentResources(): AgentResources {
  const value = process.env.PIOP_AGENT_RESOURCES;
  if (!value) throw new Error("Agent startup resources are unavailable");
  return parseAgentResources(JSON.parse(value));
}
