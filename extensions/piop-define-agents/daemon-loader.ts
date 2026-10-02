import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { loadConfig } from "./index.ts";
import { agentSchema, agentThinkingLevels } from "./state.ts";
import { configPath, resolvePromptPath } from "./prompts.ts";
import type { RuntimeSettingsRequest } from "./contracts.ts";
import { extensionPaths } from "./extension-loader.ts";
import { extensionValidator } from "./validation-runtime.ts";

const settings = JSON.parse(process.argv[2] || "{}");

function validateEffort(name: string, value: string | undefined) {
  const effort = value?.trim();

  if (effort && !agentThinkingLevels.some(level => level === effort)) throw new Error(`Agent "${name}" has an unknown thinking level: ${effort}`);
}

const sourceAgentSchema = Type.Object({
  ...Type.Partial(Type.Omit(agentSchema, ["mcpServers"])).properties,
  name: Type.String({ pattern: "\\S" }),
  systemPrompt: Type.Optional(Type.String()), agentsMd: Type.Optional(Type.String()), developerPrompt: Type.Optional(Type.String()),
});

await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

let stored;

try {
  stored = JSON.parse(await readFile(configPath, "utf8"));

  if (!stored || !Array.isArray(stored.agents) || stored.agents.length === 0) throw new Error("Agent configuration must contain an agents array");
  const names = new Set<string>();

  for (const agent of stored.agents) {
    if (!Check(sourceAgentSchema, agent)) throw new Error("Invalid agent definition: check names, prompts, tools, skills and options");
    validateEffort(agent.name, agent.effort);

    if (names.has(agent.name)) throw new Error(`Duplicate agent name: ${agent.name}`);
    names.add(agent.name);
  }
} catch (error) {
  if (process.env.PIOP_AGENT_INITIAL_LOAD !== "1" || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const api = { events: { emit(_name: string, request: RuntimeSettingsRequest) { request.settings = settings; } } };

const config = await loadConfig(api, stored, process.env.PIOP_AGENT_INITIAL_LOAD === "1");

if (!Check(Type.Array(agentSchema), config.agents)) throw new Error("Invalid agent definitions");

const prompts: Record<string, string> = {};

if (!Check(Type.Array(Type.String()), settings.registeredTools)) throw new Error("Registered tool inventory is unavailable");

const validateExtensions = config.agents.some(agent => agent.extensions?.length) ? await extensionValidator(settings.registeredTools) : undefined;

for (const agent of config.agents) {
  validateEffort(agent.name, agent.effort);
  let extensionTools: string[] = [];

  if (validateExtensions) {
    try { extensionTools = await validateExtensions(extensionPaths(agent.extensions), dirname(configPath)); }
    catch (error) { throw new Error(`Agent "${agent.name}" cannot load its extensions: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const allowedTools = new Set([...settings.tools, ...extensionTools]);
  const denied = agent.tools.filter(tool => !allowedTools.has(tool));

  if (denied.length) throw new Error(`Agent "${agent.name}" cannot run because Pi does not allow its configured tools: ${denied.join(", ")}`);

  for (const path of [agent.path_systemprompt, agent.path_agentprompt].filter(Boolean)) {
    const resolved = resolvePromptPath(path);
    prompts[resolved] ??= await readFile(resolved, "utf8");
  }
}

const responsePath = process.env.PIOP_AGENT_RESPONSE_PATH;

if (!responsePath) throw new Error("Agent definitions response channel is unavailable");

await writeFile(responsePath, JSON.stringify({ config, prompts, configPath }), { mode: 0o600 });
