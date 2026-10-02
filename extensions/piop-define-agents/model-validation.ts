import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadAccountProviders } from "../piop-runtime-settings/provider-accounts.mjs";
import { createFastModeDiscovery } from "../piop-openai-fast-mode/src/discovery.ts";
import { piDirectory } from "./validation-runtime.ts";
import type { Agent } from "./contracts.ts";

async function configuredFastTargets(agentDir: string) {
  const path = join(agentDir, "extensions", "piop-openai-fast-mode", "config.json");
  const legacy = join(agentDir, "extensions", "pi-openai-fast-mode-piop", "config.json");
  const targets: Array<{ provider: string; model: string }> = [];

  try {
    const text = await readFile(path, "utf8").catch(() => readFile(legacy, "utf8"));
    const value = JSON.parse(text);

    if (!Array.isArray(value.targets)) return targets;

    for (const target of value.targets) {
      if (Check(Type.Object({ provider: Type.String(), model: Type.String() }), target)) targets.push({ provider: target.provider.trim().toLowerCase(), model: target.model.trim() });
    }
  } catch { }

  return targets;
}

function configuredModel(registry: ModelRegistry, agent: Agent, name: string) {
  const [provider, ...parts] = name.split("/");
  const model = registry.find(provider, parts.join("/"));

  if (!model && name && agent.extensions?.length) return;

  if (!model) throw new Error(`Agent "${agent.name}" cannot run because model ${name || "(unset)"} is unavailable`);

  return model;
}

export async function modelValidator() {
  const directory = await piDirectory();
  const { ModelRuntime: Runtime } = await import(pathToFileURL(join(directory, "dist/core/model-runtime.js")).href);
  const { ModelRegistry: Registry } = await import(pathToFileURL(join(directory, "dist/core/model-registry.js")).href);
  const { getAgentDir } = await import(pathToFileURL(join(directory, "dist/config.js")).href);
  const createRuntime = (): Promise<ModelRuntime> => Runtime.create({ allowModelNetwork: false });
  const runtime = await createRuntime();
  const accounts = await loadAccountProviders(join(getAgentDir(), "auth.json"), createRuntime);

  for (const provider of accounts.values()) runtime.registerNativeProvider(provider);
  const registry: ModelRegistry = new Registry(runtime);
  const discoverFast = createFastModeDiscovery();
  const configured = await configuredFastTargets(getAgentDir());

  return async (agent: Agent, defaultModel: string) => {
    const name = agent.model.trim() || (agent.fastMode ? defaultModel.trim() : "");

    if (!name && !agent.fastMode) return;
    const model = configuredModel(registry, agent, name);

    if (!model) return;

    if (!agent.fastMode) return;
    let unknown = false;

    const targets = await discoverFast({ modelRegistry: registry, model }, configured, candidate => {
      if (candidate.provider === model.provider && candidate.id === model.id) unknown = true;
    });

    if (!unknown && !targets.some(target => target.provider === model.provider && target.model === model.id)) throw new Error(`Agent "${agent.name}" cannot enable Fast mode for model ${name}`);
  };
}
