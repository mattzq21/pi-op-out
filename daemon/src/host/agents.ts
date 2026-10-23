import { join } from 'node:path';
import { hostOperation, runHostOperation } from '../host_operations';
import { generatedExtensionRoot } from '../extensions';
import { piExecutable } from '../environment';
import type { FastModelSnapshot } from './fast_models';

const definitions = hostOperation<{ settings: any; initial: boolean }, any>('agent-definitions', 'agents', 30_000, value => {
  const result = value as any;
  if (!Array.isArray(result?.config?.agents) || result.prompts === null || typeof result.prompts !== 'object' || Array.isArray(result.prompts) || typeof result.configPath !== 'string') throw new Error('Invalid agent definitions');
  return result;
});

/** Loads the agent definitions of the profile at home/storage in a new worker, because the loader reads its paths from the environment once. */
export function load(home: string, storage: string, settings: any, initial: boolean, fastModels: FastModelSnapshot | null): Promise<any> {
  const profile = join(home, storage);
  return runHostOperation(definitions, { settings: { ...settings, fastModels }, initial }, {
    env: {
      HOME: home, PIOP_BUN: process.execPath, PIOP_STORAGE_DIRECTORY: storage, PI_CODING_AGENT_DIR: profile,
      PIOP_AGENT_CONFIG_PATH: join(profile, 'piop-define-agents/config.json'), PIOP_GENERATED_EXTENSION_ROOT: generatedExtensionRoot(), PIOP_PI_EXECUTABLE: piExecutable(),
    },
  });
}
