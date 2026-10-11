import { hostScript, runHostScript } from '../host_script';
import { generatedExtensionRoot } from '../extensions';
import { piExecutable } from '../environment';

interface Request { home: string; storage: string; settings: any; initial: boolean; extensionRoot: string; pi: string; cwd: string }

const definitions = hostScript<Request, any>('agent-definitions', 16 * 1024 * 1024, value => {
  const result = value as any;
  if (!Array.isArray(result?.config?.agents) || result.prompts === null || typeof result.prompts !== 'object' || Array.isArray(result.prompts)) throw new Error('Invalid agent definitions');
  return result;
});

export function load(home: string, storage: string, settings: any, initial: boolean): Promise<any> {
  return runHostScript({ kind: 'local' }, definitions, { home, storage, settings, initial, extensionRoot: generatedExtensionRoot(), pi: piExecutable(), cwd: process.cwd() }, { signal: AbortSignal.timeout(30_000) });
}
