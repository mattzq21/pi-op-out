import { build } from 'esbuild';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let compiled;
function compileGoalFiles() {
  return compiled ??= build({ stdin: { contents: 'export { materializeGoal } from "./daemon/src/host/goals/files.ts";', resolveDir: process.cwd() }, write: false, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }).then(result => result.outputFiles[0].contents);
}

export async function goalCommand(t) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-goal-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'goal-files.mjs');
  await writeFile(outfile, await compileGoalFiles());
  const { materializeGoal } = await import(pathToFileURL(outfile));
  return async (sessionPath, objective) => {
    const header = JSON.parse((await readFile(sessionPath, 'utf8')).split('\n')[0]);
    const draft = await materializeGoal({ file: sessionPath, sessionId: header.id, cwd: header.cwd }, objective, crypto.randomUUID());
    await draft.bind(crypto.randomUUID());
    return { message: '/goal ' + draft.objective };
  };
}
