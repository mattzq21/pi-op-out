import { mkdir } from "node:fs/promises";
import { Check, Errors, Parse } from "typebox/value";
import { Type } from "typebox";
import { loadConfig, normalizeConfig, type Config } from "./index.ts";
import { agentSchema, agentThinkingLevels } from "./state.ts";
import { agentDirectory, moveLegacyDefinitions, readConfigDocument, readPrompt, resolvePromptPath, isNamedAgent, writeConfig } from "./prompts.ts";
import { parseAgentResources, parsePluginAgentTools } from "./resources.ts";
import { extensionPaths } from "./extension-loader.ts";
import { extensionValidator } from "./validation-runtime.ts";
import { modelValidator } from "./model-validation.ts";
import { parseFastModelSnapshot } from "./fast-models.ts";
import { mcpServersSchema } from "./mcp-schema.ts";

function validateEffort(name: string, value: string | undefined) {
  const effort = value?.trim();

  if (effort && !agentThinkingLevels.some(level => level === effort)) throw new Error(`Agent "${name}" has an unknown thinking level: ${effort}`);
}

const sourceAgentSchema = Type.Object({
  ...Type.Partial(Type.Omit(agentSchema, ["mcpServers"])).properties,
  name: Type.String({ pattern: "\\S" }),
  systemPrompt: Type.Optional(Type.String()), agentsMd: Type.Optional(Type.String()), developerPrompt: Type.Optional(Type.String()),
});

/** settings holds startup tool/skill lists and host model validation results. */
export interface AgentDefinitionsRequest { settings: any; initial: boolean }

export interface AgentDefinitions { config: any; prompts: Record<string, string> }

/** The definitions to save, with the revision they were edited from. */
export interface SaveAgentDefinitionsRequest { settings: any; configuration: unknown }

const savedConfigurationSchema = Type.Object({ revision: Type.String({ minLength: 1 }), agents: Type.Array(agentSchema) });

function configRuntime(settings: any) {
  const { tools } = parseAgentResources(settings);

  return { tools, api: { enabledTools: tools.enabledTools, pluginTools: parsePluginAgentTools(settings) } };
}

/** Rejects agents whose prompt files cannot be read. */
async function requireReadablePrompts(agents: Config["agents"]) {
  for (const agent of agents) {
    for (const [label, path] of [["System prompt", agent.path_systemprompt], ["Agent prompt", agent.path_agent_prompt]] as const) {
      if (!path?.trim()) continue;

      try { await readPrompt(resolvePromptPath(path)); }
      catch (error) {
        const reason = error instanceof Error && "code" in error && error.code === "ENOENT" ? "does not exist" : `cannot be read: ${error instanceof Error ? error.message : String(error)}`;
        throw new Error(`Agent "${agent.name}": ${label} file ${path} ${reason}`);
      }
    }
  }
}

/** Checks every agent as a new agent would start: thinking level, model, extensions and prompts. A missing model only marks the agent unavailable. */
async function checkAgents(config: Config, settings: any, registeredTools: readonly string[], prompts: Record<string, string>) {
  if (!Check(Type.Array(agentSchema), config.agents)) throw new Error("Invalid agent definitions");

  const validateExtensions = config.agents.some(agent => agent.extensions?.length) ? await extensionValidator([...registeredTools]) : undefined;

  const validateModel = await modelValidator(parseFastModelSnapshot(settings.fastModels));

  for (const agent of config.agents) {
    validateEffort(agent.name, agent.effort);
    mcpServersSchema.parse(agent.mcpServers);

    agent.unavailableReason = await validateModel(agent, async (registry, validate) => {
      if (!validateExtensions) return validate();

      try { await validateExtensions(extensionPaths(agent.extensions), agentDirectory, registry, agent, validate); }
      catch (error) { throw new Error(`Agent "${agent.name}" cannot load its extensions: ${error instanceof Error ? error.message : String(error)}`); }
    });

    for (const path of [agent.path_systemprompt, agent.path_agent_prompt].filter(Boolean)) {
      const resolved = resolvePromptPath(path);
      prompts[resolved] ??= await readPrompt(resolved);
    }
  }
}

/**
 * Reads and checks the agent definitions for the daemon. initial moves old definitions, creates missing ones and saves migrations.
 * The paths come from the environment of the calling thread, which the daemon sets for each load.
 */
export async function loadAgentDefinitions({ settings, initial: initialize }: AgentDefinitionsRequest): Promise<AgentDefinitions> {
  if (initialize) { await mkdir(agentDirectory, { recursive: true, mode: 0o700 }); moveLegacyDefinitions(); }

  let stored;

  try {
    stored = await readConfigDocument();

    if (!stored || !Array.isArray(stored.agents) || stored.agents.length === 0) throw new Error("Agent configuration must contain an agents array");
    const names = new Set<string>();

    for (const agent of stored.agents.filter(isNamedAgent)) {
      if (!Check(sourceAgentSchema, agent)) throw new Error("Invalid agent definition: check names, prompts, tools, skills and options");
      validateEffort(agent.name, agent.effort);

      if (names.has(agent.name)) throw new Error(`Duplicate agent name: ${agent.name}`);
      names.add(agent.name);
    }
  } catch (error) {
    if (!initialize || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const { tools, api } = configRuntime(settings);
  const prompts: Record<string, string> = {};
  const config = await loadConfig(api, stored, initialize, initialize ? undefined : readOnlyStorage(prompts));
  await checkAgents(config, settings, tools.registeredTools, prompts);

  return { config, prompts };
}

/** Storage that writes nothing: it collects the prompts that migrations would write. */
function readOnlyStorage(prompts: Record<string, string>) {
  return {
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
}

/**
 * Checks the supplied agent definitions like a load does and saves them when their revision is still the saved one.
 * Returns the saved definitions as a load would read them, so they need no second load.
 */
export async function saveAgentDefinitions({ settings, configuration }: SaveAgentDefinitionsRequest): Promise<{ revision: string; warnings: string[]; definitions: AgentDefinitions }> {
  const errors = [...Errors(savedConfigurationSchema, configuration)];

  if (errors.length) throw new Error(`Invalid agent configuration: ${errors.map(error => `${error.instancePath} ${error.message}`).join("; ")}`);
  const supplied = Parse(savedConfigurationSchema, configuration);
  const { tools, api } = configRuntime(settings);
  const stored = await readConfigDocument();
  const next = normalizeConfig({ ...stored, ...supplied }, api);
  next.sessionToolsDefaultApplied = true;
  next.subagentsDefaultApplied = true;
  next.pluginToolsApplied = [...new Set([...next.pluginToolsApplied ?? [], ...api.pluginTools])];
  await requireReadablePrompts(next.agents);
  const prompts: Record<string, string> = {};
  const loaded = await loadConfig(api, structuredClone(next), false, readOnlyStorage(prompts));
  await checkAgents(loaded, settings, tools.registeredTools, prompts);
  const saved = await writeConfig(next);

  if (!saved?.revision) throw new Error("Agent definitions were not saved");
  loaded.revision = saved.revision;

  return { revision: saved.revision, warnings: saved.warnings, definitions: { config: loaded, prompts } };
}
