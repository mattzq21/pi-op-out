import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { loadConfig } from "./index.ts";
import { agentSchema, agentThinkingLevels } from "./state.ts";
import { configPath, resolvePromptPath } from "./prompts.ts";
import type { RuntimeSettingsRequest } from "./contracts.ts";
import { extensionPaths, validateExtensionModules } from "./extension-loader.ts";
import { validationImporter } from "./validation-runtime.ts";

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

const importer = config.agents.some(agent => agent.extensions?.length) ? await validationImporter() : undefined;

for (const agent of config.agents) {
  validateEffort(agent.name, agent.effort);

  if (importer) {
    try { await validateExtensionModules(extensionPaths(agent.extensions), dirname(configPath), importer); }
    catch (error) { throw new Error(`Agent "${agent.name}" cannot load its extensions: ${error instanceof Error ? error.message : String(error)}`); }
  }

  for (const path of [agent.path_systemprompt, agent.path_agentprompt].filter(Boolean)) {
    const resolved = resolvePromptPath(path);
    prompts[resolved] ??= await readFile(resolved, "utf8");
  }
}

process.stdout.write(JSON.stringify({ config, prompts, configPath }));
