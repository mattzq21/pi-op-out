import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';

const { home, path, message } = JSON.parse(readFileSync(0, 'utf8'));
let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (true) {
  const manifest = join(root, 'package.json');
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') break;
  const parent = dirname(root);
  if (parent === root) throw new Error('Could not locate the installed Pi SDK');
  root = parent;
}
process.env.HOME = home;
delete process.env.PIOP_STORAGE_DIRECTORY;
const directory = mkdtempSync(join(home, 'append-chat-test-'));
try {
  const outfile = join(directory, 'storage.mjs');
  await build({
    entryPoints: ['daemon/resources/piop-storage/session-storage.mjs'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    logLevel: 'silent', plugins: [storageSchemaImports()],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const { installSessionStorage } = await import(pathToFileURL(outfile));
  const { SessionManager } = await import(pathToFileURL(join(root, 'dist/core/session-manager.js')));
  installSessionStorage(SessionManager);
  const manager = SessionManager.open(path);
  const entryId = manager.appendMessage(message);
  process.stdout.write(JSON.stringify({ entryId }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
