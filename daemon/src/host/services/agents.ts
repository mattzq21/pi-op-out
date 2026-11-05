import { join } from 'node:path';
import { z } from 'zod';
import { hostOperation, runHostOperation } from '../../host_operations';
import { installedPi } from '../../pi_install';
import * as Contributions from '../../plugins';
import type { FastModelSnapshot } from './fast_models';

const definitionsSchema = z.looseObject({ config: z.looseObject({ agents: z.array(z.unknown()) }), prompts: z.record(z.string(), z.unknown()) });

type Project = { cwd: string; global: any };

const definitions = hostOperation<{ settings: any; initial: boolean; project?: Project }, any>('agent-definitions', 'agents', 30_000, definitionsSchema);

export interface Saved { revision: string; warnings: string[]; definitions: any }

const savedSchema = z.object({ revision: z.string(), warnings: z.array(z.string()), definitions: definitionsSchema });

const saved = hostOperation<{ settings: any; configuration: unknown; project?: Project }, Saved>('save-agent-definitions', 'agents', 30_000, savedSchema);

export interface Move { global: any; agent: string; revision: string; from: string | null; to: string | null }

const moved = hostOperation<{ settings: any } & Move, Saved>('move-agent', 'agents', 30_000, savedSchema);

async function environment(home: string, storage: string): Promise<Record<string, string>> {
  const profile = join(home, storage);
  return {
    HOME: home, PIOP_STORAGE_DIRECTORY: storage, PI_CODING_AGENT_DIR: profile,
    PIOP_STORAGE_ROOT: profile, PIOP_PI_ROOT: (await installedPi()).root,
  };
}

function loaderSettings(settings: any, fastModels: FastModelSnapshot | null): any {
  return { ...settings, pluginAgentTools: Contributions.agentTools(), fastModels };
}

export async function load(home: string, storage: string, settings: any, initial: boolean, fastModels: FastModelSnapshot | null, project?: Project): Promise<any> {
  return runHostOperation(definitions, { settings: loaderSettings(settings, fastModels), initial, ...(project ? { project } : {}) }, { env: await environment(home, storage) });
}

export async function move(home: string, storage: string, settings: any, fastModels: FastModelSnapshot | null, request: Move): Promise<Saved> {
  return runHostOperation(moved, { settings: loaderSettings(settings, fastModels), ...request }, { env: await environment(home, storage) });
}

export async function save(home: string, storage: string, settings: any, configuration: unknown, fastModels: FastModelSnapshot | null, project?: Project): Promise<Saved> {
  return runHostOperation(saved, { settings: loaderSettings(settings, fastModels), configuration, ...(project ? { project } : {}) }, { env: await environment(home, storage) });
}
