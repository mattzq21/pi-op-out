import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piDirectory } from "./validation-runtime.ts";
import { installRuntimeStorage } from "../../daemon/resources/sdk-storage.mjs";
import type { Agent } from "./contracts.ts";
import { fastModelProblem, type FastModelSnapshot } from "./fast-models.ts";

function configuredModel(registry: ModelRegistry, agent: Agent, name: string) {
  const [provider, ...parts] = name.split("/");
  const model = registry.find(provider, parts.join("/"));

  if (!model) throw new Error(`Agent "${agent.name}" cannot run because model ${name || "(unset)"} is unavailable`);

  return model;
}

/** fastModels holds the host's fast model results, or null before the host has scanned. */
export async function modelValidator(fastModels: FastModelSnapshot | null) {
  const directory = await piDirectory();
  await installRuntimeStorage(directory);
  const { ModelRuntime: Runtime } = await import(pathToFileURL(join(directory, "dist/core/model-runtime.js")).href);
  const { ModelRegistry: Registry } = await import(pathToFileURL(join(directory, "dist/core/model-registry.js")).href);
  const createRuntime = (): Promise<ModelRuntime> => Runtime.create({ allowModelNetwork: false });

  return async (agent: Agent, activate: (registry: ModelRegistry, validate: () => Promise<void>) => Promise<void>) => {
    const runtime = await createRuntime();
    const registry: ModelRegistry = new Registry(runtime);
    await activate(registry, async () => {
      const name = agent.model.trim();

      if (!name && !agent.fastMode) return;
      const model = configuredModel(registry, agent, name);

      if (!agent.fastMode) return;
      const problem = fastModelProblem(fastModels, agent.name, `${model.provider}/${model.id}`);

      if (problem) throw new Error(problem);
    });
  };
}
