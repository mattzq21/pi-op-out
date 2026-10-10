import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { agentDefinitionsBundle } from '../resources';
import { generatedExtensionRoot } from '../extensions';
import { piExecutable } from '../environment';

export function load(home: string, storage: string, settings: any, initial: boolean): Promise<any> {
  const path = join(home, storage, 'piop-define-agents/config.json');
  const response = randomUUID();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('node', ['--input-type=module', '-', JSON.stringify(settings)], {
        env: { ...process.env, HOME: home, PIOP_STORAGE_DIRECTORY: storage, PI_CODING_AGENT_DIR: join(home, storage), PIOP_AGENT_CONFIG_PATH: path,
          PIOP_AGENT_RESPONSE_ID: response, PIOP_GENERATED_EXTENSION_ROOT: generatedExtensionRoot(), PIOP_PI_EXECUTABLE: piExecutable(), PIOP_AGENT_INITIAL_LOAD: initial ? '1' : '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: any) { reject(new Error('Could not load agent definitions: ' + error.message)); return; }
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Loading agent definitions timed out')); }, 30_000);
    child.stdout!.on('data', chunk => stdout.push(chunk));
    child.stderr!.on('data', chunk => stderr.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(new Error('Could not load agent definitions: ' + error.message)); });
    child.stdin!.on('error', () => {});
    child.stdin!.end(agentDefinitionsBundle);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('Could not load agent definitions: ' + Buffer.concat(stderr).toString().trim())); return; }
      try { resolve(readDefinitions(Buffer.concat(stdout).toString(), response)); } catch (error) { reject(error); }
    });
  });
}

function readDefinitions(output: string, response: string): any {
  const prefix = response + ':';
  const line = output.split('\n').reverse().find(item => item.startsWith(prefix));
  if (line === undefined) throw new Error('Agent definitions response is missing');
  let definitions: any;
  try { definitions = JSON.parse(line.slice(prefix.length)); } catch (error: any) { throw new Error('Invalid agent definitions: ' + error.message); }
  if (!Array.isArray(definitions?.config?.agents) || definitions.prompts === null || typeof definitions.prompts !== 'object' || Array.isArray(definitions.prompts)) throw new Error('Invalid agent definitions');
  return definitions;
}
