import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { loadConfig } from "./index.ts";
import { agentSchema, agentThinkingLevels } from "./state.ts";
import { configPath, readConfigDocument, readPrompt, resolvePromptPath } from "./prompts.ts";
import type { ToolLists, ToolStoreRequest } from "../piop-tool-store/interface.ts";
import { extensionPaths } from "./extension-loader.ts";
import { extensionValidator } from "./validation-runtime.ts";
import { modelValidator } from "./model-validation.ts";
import { parseFastModelSnapshot } from "./fast-models.ts";

function validateEffort(name: string, value: string | undefined) {
  const effort = value?.trim();

  if (effort && !agentThinkingLevels.some(level => level === effort)) throw new Error(`Agent "${name}" has an unknown thinking level: ${effort}`);
}

const sourceAgentSchema = Type.Object({
  ...Type.Partial(Type.Omit(agentSchema, ["mcpServers"])).properties,
  name: Type.String({ pattern: "\\S" }),
  systemPrompt: Type.Optional(Type.String()), agentsMd: Type.Optional(Type.String()), developerPrompt: Type.Optional(Type.String()),
});

/** settings holds the runtime settings that the daemon sends to Pi, with tools as the tool store lists. */
export interface AgentDefinitionsRequest { settings: any; initial: boolean }

const toolListsSchema = Type.Object({ enabledTools: Type.Array(Type.String()), registeredTools: Type.Array(Type.String()) });

export interface AgentDefinitions { config: any; prompts: Record<string, string>; configPath: string }

/**
 * Reads and checks the agent definitions for the daemon. initial creates missing configuration files.
 * The configuration paths come from the environment of the calling thread, which the daemon sets for each load.
 */
export async function loadAgentDefinitions({ settings, initial: initialize }: AgentDefinitionsRequest): Promise<AgentDefinitions> {
  if (initialize) await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

  let stored;

  try {
    stored = await readConfigDocument();

    if (!stored || !Array.isArray(stored.agents) || stored.agents.length === 0) throw new Error("Agent configuration must contain an agents array");
    const names = new Set<string>();

    for (const agent of stored.agents) {
      if (!Check(sourceAgentSchema, agent)) throw new Error("Invalid agent definition: check names, prompts, tools, skills and options");
      validateEffort(agent.name, agent.effort);

      if (names.has(agent.name)) throw new Error(`Duplicate agent name: ${agent.name}`);
      names.add(agent.name);
    }
  } catch (error) {
    if (!initialize || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (!Check(toolListsSchema, settings.tools)) throw new Error("Tool lists are unavailable");
  const toolLists: ToolLists = settings.tools;

  const api = { events: { emit(_name: "piop:tool-store", request: ToolStoreRequest) {
    request.store = { lists: () => structuredClone(toolLists), replace() { throw new Error("Agent definitions cannot change tool lists"); } };
  } } };

  const prompts: Record<string, string> = {};

  const readOnlyStorage = {
    async writeConfig() {},
    async ensurePromptFile(path: string, contents: string) {
      const resolved = resolvePromptPath(path);

      try { prompts[resolved] ??= await readPrompt(resolved); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        prompts[resolved] ??= contents;
      }
    },
  };

  const config = await loadConfig(api, stored, initialize, initialize ? undefined : readOnlyStorage);

  if (!Check(Type.Array(agentSchema), config.agents)) throw new Error("Invalid agent definitions");

  const validateExtensions = config.agents.some(agent => agent.extensions?.length) ? await extensionValidator([...toolLists.registeredTools]) : undefined;

  const validateModel = await modelValidator(parseFastModelSnapshot(settings.fastModels));

  for (const agent of config.agents) {
    validateEffort(agent.name, agent.effort);
    let extensionTools: string[] = [];

    await validateModel(agent, settings.defaultModel ?? "", async (registry, validate) => {
      if (!validateExtensions) return validate();

      try { extensionTools = await validateExtensions(extensionPaths(agent.extensions), dirname(configPath), registry, agent, validate); }
      catch (error) { throw new Error(`Agent "${agent.name}" cannot load its extensions: ${error instanceof Error ? error.message : String(error)}`); }
    });

    const allowedTools = new Set([...toolLists.enabledTools, ...extensionTools]);
    const denied = agent.tools.filter(tool => !allowedTools.has(tool));

    if (denied.length) throw new Error(`Agent "${agent.name}" cannot run because Pi does not allow its configured tools: ${denied.join(", ")}`);

    for (const path of [agent.path_systemprompt, agent.path_agent_prompt].filter(Boolean)) {
      const resolved = resolvePromptPath(path);
      prompts[resolved] ??= await readPrompt(resolved);
    }
  }

  return { config, prompts, configPath };
}
