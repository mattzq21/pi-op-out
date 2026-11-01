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

type Project = { cwd: string; global: any };

const definitions = hostOperation<{ settings: any; initial: boolean; project?: Project }, any>('agent-definitions', 'agents', 30_000, readDefinitions);

export interface Saved { revision: string; warnings: string[]; definitions: any }

function readSaved(value: unknown): Saved {
  const result = value as any;
  if (typeof result?.revision !== 'string' || !Array.isArray(result.warnings) || result.warnings.some((warning: unknown) => typeof warning !== 'string')) throw new Error('Invalid agent definitions save result');
  return { revision: result.revision, warnings: result.warnings, definitions: readDefinitions(result.definitions) };
}

const saved = hostOperation<{ settings: any; configuration: unknown; project?: Project }, Saved>('save-agent-definitions', 'agents', 30_000, readSaved);

export interface Move { global: any; agent: string; revision: string; from: string | null; to: string | null }

const moved = hostOperation<{ settings: any } & Move, Saved>('move-agent', 'agents', 30_000, readSaved);

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

export function load(home: string, storage: string, settings: any, initial: boolean, fastModels: FastModelSnapshot | null, project?: Project): Promise<any> {
  return runHostOperation(definitions, { settings: loaderSettings(settings, fastModels), initial, ...(project ? { project } : {}) }, { env: environment(home, storage) });
}

export function move(home: string, storage: string, settings: any, fastModels: FastModelSnapshot | null, request: Move): Promise<Saved> {
  return runHostOperation(moved, { settings: loaderSettings(settings, fastModels), ...request }, { env: environment(home, storage) });
}

export function save(home: string, storage: string, settings: any, configuration: unknown, fastModels: FastModelSnapshot | null, project?: Project): Promise<Saved> {
  return runHostOperation(saved, { settings: loaderSettings(settings, fastModels), configuration, ...(project ? { project } : {}) }, { env: environment(home, storage) });
}
