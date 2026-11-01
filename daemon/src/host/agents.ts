import { join } from 'node:path';
import { hostOperation, runHostOperation } from '../host_operations';
import { generatedExtensionRoot } from '../extensions';
import { piExecutable } from '../environment';
import * as Contributions from '../plugin_contributions';
import type { FastModelSnapshot } from './fast_models';

function readDefinitions(value: unknown): any {
  const result = value as any;
  if (!Array.isArray(result?.config?.agents) || result.prompts === null || typeof result.prompts !== 'object' || Array.isArray(result.prompts)) throw new Error('Invalid agent definitions');
  return result;
}

const definitions = hostOperation<{ settings: any; initial: boolean }, any>('agent-definitions', 'agents', 30_000, readDefinitions);

export interface Saved { revision: string; warnings: string[]; definitions: any }

const saved = hostOperation<{ settings: any; configuration: unknown }, Saved>('save-agent-definitions', 'agents', 30_000, value => {
  const result = value as any;
  if (typeof result?.revision !== 'string' || !Array.isArray(result.warnings) || result.warnings.some((warning: unknown) => typeof warning !== 'string')) throw new Error('Invalid agent definitions save result');
  return { revision: result.revision, warnings: result.warnings, definitions: readDefinitions(result.definitions) };
});

function environment(home: string, storage: string): Record<string, string> {
  const profile = join(home, storage);
  return {
    HOME: home, PIOP_BUN: process.execPath, PIOP_STORAGE_DIRECTORY: storage, PI_CODING_AGENT_DIR: profile,
    PIOP_STORAGE_ROOT: profile, PIOP_GENERATED_EXTENSION_ROOT: generatedExtensionRoot(), PIOP_PI_EXECUTABLE: piExecutable(),
  };
}

function loaderSettings(settings: any, fastModels: FastModelSnapshot | null): any {
  return { ...settings, pluginAgentTools: Contributions.agentTools(), fastModels };
}

export function load(home: string, storage: string, settings: any, initial: boolean, fastModels: FastModelSnapshot | null): Promise<any> {
  return runHostOperation(definitions, { settings: loaderSettings(settings, fastModels), initial }, { env: environment(home, storage) });
}

export function save(home: string, storage: string, settings: any, configuration: unknown, fastModels: FastModelSnapshot | null): Promise<Saved> {
  return runHostOperation(saved, { settings: loaderSettings(settings, fastModels), configuration }, { env: environment(home, storage) });
}
