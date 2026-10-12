import { hostScript, runHostScript } from '../host_script';
import { generatedExtensionRoot } from '../extensions';
import { piExecutable } from '../environment';
import type { FastModelSnapshot } from './fast_models';

interface Request { home: string; storage: string; settings: any; initial: boolean; extensionRoot: string; pi: string; cwd: string }

const definitions = hostScript<Request, any>('agent-definitions', 16 * 1024 * 1024, value => {
  const result = value as any;
  if (!Array.isArray(result?.config?.agents) || result.prompts === null || typeof result.prompts !== 'object' || Array.isArray(result.prompts)) throw new Error('Invalid agent definitions');
  return result;
});

/** fastModels is null before the host has scanned; validation then leaves fast mode checks to the session. */
export function load(home: string, storage: string, settings: any, initial: boolean, fastModels: FastModelSnapshot | null): Promise<any> {
  return runHostScript({ kind: 'local' }, definitions, { home, storage, settings: { ...settings, fastModels }, initial, extensionRoot: generatedExtensionRoot(), pi: piExecutable(), cwd: process.cwd() }, { signal: AbortSignal.timeout(30_000) });
}
