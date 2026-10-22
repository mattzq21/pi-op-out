import { build } from 'esbuild';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

let compiled;
function compileGoal() {
  return compiled ??= build({ stdin: { contents: 'export { default } from "./daemon/resources/piop-goals/index.ts"; export { default as hooksExtended } from "./daemon/resources/hooks-extended/index.ts";', resolveDir: process.cwd() }, write: false, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports(), { name: 'external-pi-sdk', setup(api) { api.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: 'pi-ai', namespace: 'sdk' })); api.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({ contents: 'export { Type } from \"@sinclair/typebox\";', resolveDir: process.cwd() })); } }],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }).then(result => result.outputFiles[0].contents);
}

export async function goalCommand(t) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-goal-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'broker.mjs');
  await writeFile(outfile, await compileGoal());
  const { default: broker, hooksExtended } = await import(pathToFileURL(outfile));
  return async (sessionPath, objective) => {
    const entries = (await readFile(sessionPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const header = entries[0];
    const listeners = new Map();
    const tools = [];
    const pi = {
      on() {}, registerCommand() {}, registerTool(tool) { tools.push(tool.name); },
      events: { emit(name, event) { for (const handler of listeners.get(name) ?? []) handler(event); }, on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => listeners.set(name, list.filter(value => value !== handler)); } },
      getActiveTools: () => tools,
    };
    hooksExtended(pi);
    broker(pi);
    const request = { command: 'prepare_goal_prompt', payload: { message: '/goal ' + objective, goalSubmissionId: crypto.randomUUID() }, ctx: {
      cwd: header.cwd, isIdle: () => true,
      sessionManager: { getSessionId: () => header.id, getSessionFile: () => sessionPath, getSessionDir: () => dirname(sessionPath), getBranch: () => entries.slice(1) },
      ui: { notify(message) { throw new Error(message); } },
    } };
    for (const handler of listeners.get('piop:rpc') ?? []) handler(request);
    if (!request.ready) throw new Error('Goal preparation command was not registered');
    return request.ready;
  };
}
