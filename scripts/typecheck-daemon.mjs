import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPi } from '../test/pi-install.mjs';

// Checks the types of the daemon and its Pi extensions. Pi's types come from the Pi that the daemon installs.
const root = fileURLToPath(new URL('../', import.meta.url));
const { root: pi } = await testPi();
const link = join(root, 'target/pi-modules');
const temporary = link + '-' + process.pid;
mkdirSync(dirname(link), { recursive: true });
symlinkSync(dirname(dirname(pi)), temporary, 'dir');
renameSync(temporary, link);
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'daemon')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
