import { mkdir } from "node:fs/promises";
import { Check, Errors, Parse } from "typebox/value";
import { Type } from "typebox";
import { loadConfig, mergeProjectAgents, normalizeConfig, projectAgents, type Config } from "./index.ts";
import { agentSchema, agentThinkingLevels } from "./state.ts";
import { agentDirectory, moveLegacyDefinitions, readConfigDocument, readPrompt, resolvePromptPath, isNamedAgent, writeConfig, projectDirectory, readProjectDocument, writeProjectDocument, writeAgentMove } from "./prompts.ts";
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

export interface AgentDefinitionsRequest { settings: any; initial: boolean; project?: { cwd: string; global: AgentDefinitions } }

export interface AgentDefinitions { config: any; prompts: Record<string, string> }

export interface SaveAgentDefinitionsRequest { settings: any; configuration: unknown; project?: { cwd: string; global: AgentDefinitions } }

const savedConfigurationSchema = Type.Object({ revision: Type.String({ minLength: 1 }), agents: Type.Array(agentSchema) });

const savedProjectSchema = Type.Object({ revision: Type.String({ minLength: 1 }), agents: Type.Optional(Type.Array(agentSchema)), defaultAgent: Type.Optional(Type.Union([Type.String({ pattern: "\\S" }), Type.Null()])) }, { additionalProperties: false });

function configRuntime(settings: any) {
  const { tools } = parseAgentResources(settings);

  return { tools, api: { enabledTools: tools.enabledTools, pluginTools: parsePluginAgentTools(settings) } };
}

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

async function loadProject(settings: any, cwd: string, global: AgentDefinitions): Promise<AgentDefinitions> {
  const { tools, api } = configRuntime(settings);
  const directory = await projectDirectory(cwd);
  const stored = readProjectDocument(directory);
  const agents = projectAgents(stored, api);
  const prompts: Record<string, string> = {};
  await checkAgents({ agents }, settings, tools.registeredTools, prompts);

  return { config: mergeProjectAgents(global.config, directory, stored, agents), prompts: { ...global.prompts, ...prompts } };
}

export async function loadAgentDefinitions({ settings, initial: initialize, project }: AgentDefinitionsRequest): Promise<AgentDefinitions> {
  if (project) return loadProject(settings, project.cwd, project.global);

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

export interface MoveAgentRequest { settings: any; global: AgentDefinitions; agent: string; revision: string; from: string | null; to: string | null }

const moveRequestSchema = Type.Object({ agent: Type.String({ pattern: "\\S" }), revision: Type.String({ minLength: 1 }), from: Type.Union([Type.String({ minLength: 1 }), Type.Null()]), to: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) });

function globalConfig(api: ReturnType<typeof configRuntime>["api"], stored: any, revision: string | undefined, agents: Config["agents"]) {
  const next = normalizeConfig({ ...stored, revision, agents }, api);
  next.sessionToolsDefaultApplied = true;
  next.subagentsDefaultApplied = true;
  next.pluginToolsApplied = [...new Set([...next.pluginToolsApplied ?? [], ...api.pluginTools])];

  return next;
}

const without = (name: string) => (agents: unknown[]) => agents.filter(item => !(isNamedAgent(item) && item.name === name));

export async function moveAgent(request: MoveAgentRequest): Promise<{ revision: string; warnings: string[]; definitions: AgentDefinitions }> {
  const errors = [...Errors(moveRequestSchema, { agent: request.agent, revision: request.revision, from: request.from, to: request.to })];

  if (errors.length) throw new Error(`Invalid agent move: ${errors.map(error => `${error.instancePath} ${error.message}`).join("; ")}`);
  const { settings, global, agent: name, revision } = request;
  const { tools, api } = configRuntime(settings);
  const from = request.from === null ? null : await projectDirectory(request.from);
  const to = request.to === null ? null : await projectDirectory(request.to);

  if (from === to) throw new Error(from === null ? "Choose a project to move the agent to" : `Agent "${name}" is already in that project`);
  let agent: Config["agents"][number] | undefined;

  if (from === null) {
    if (global.config.revision !== revision) throw new Error("Agent definitions changed in another window or client. Reload them before moving an agent.");
    agent = global.config.agents.find((item: { name: string }) => item.name === name);

    if (!agent) throw new Error(`Unknown global agent: ${name}`);

    if (name === "general") throw new Error("The general agent must stay global");

    if (agent.isDefault) throw new Error(`Agent "${name}" is the global default agent. Choose another global default agent first.`);
    agent = projectAgents({ agents: [agent] }, api)[0];
  } else {
    const project = readProjectDocument(from);

    if (project.revision !== revision) throw new Error("Project agent definitions changed in another window or client. Reload them before moving an agent.");
    agent = projectAgents(project, api).find(item => item.name === name);

    if (!agent) throw new Error(`Unknown project agent: ${name}`);
  }

  await checkAgents({ agents: [agent] }, settings, tools.registeredTools, {});
  const { unavailableReason: _reason, ...stored } = agent;
  const agents = from === null ? global.config.agents.filter((item: { name: string }) => item.name !== name) : to === null ? [...global.config.agents, agent] : global.config.agents;
  const projects = [
    ...(from === null ? [] : [{ directory: from, change: (project: { agents: unknown[] }) => ({ revision, agents: without(name)(project.agents) }) }]),
    ...(to === null ? [] : [{ directory: to, change: (project: { agents: unknown[] }, current: string) => ({ revision: current, agents: [...project.agents, stored] }) }]),
  ];
  const changesGlobal = from === null || to === null;
  const saved = writeAgentMove(changesGlobal ? globalConfig(api, await readConfigDocument(), global.config.revision, agents) : undefined, projects) ?? global.config.revision;

  return { revision: saved, warnings: [], definitions: { config: { ...global.config, revision: saved, agents }, prompts: global.prompts } };
}

async function saveProject(settings: any, configuration: unknown, cwd: string, global: AgentDefinitions) {
  const errors = [...Errors(savedProjectSchema, configuration)];

  if (errors.length) throw new Error(`Invalid project agent configuration: ${errors.map(error => `${error.instancePath} ${error.message}`).join("; ")}`);
  const supplied = Parse(savedProjectSchema, configuration);
  const directory = await projectDirectory(cwd);

  if (supplied.agents) {
    const { tools, api } = configRuntime(settings);
    const agents = projectAgents({ agents: supplied.agents }, api);
    await requireReadablePrompts(agents);
    await checkAgents({ agents }, settings, tools.registeredTools, {});
    mergeProjectAgents(global.config, directory, { agents: [], revision: supplied.revision }, agents);
    supplied.agents = agents.map(({ unavailableReason: _reason, ...agent }) => agent);
  }

  const revision = writeProjectDocument(directory, supplied);

  return { revision, warnings: [], definitions: global };
}

export async function saveAgentDefinitions({ settings, configuration, project }: SaveAgentDefinitionsRequest): Promise<{ revision: string; warnings: string[]; definitions: AgentDefinitions }> {
  if (project) return saveProject(settings, configuration, project.cwd, project.global);
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
