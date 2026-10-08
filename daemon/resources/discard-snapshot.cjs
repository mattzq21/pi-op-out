const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const database = require('./session-database.cjs');

try {
  const profile = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');
  const parent = fs.realpathSync(path.join(profile, 'git-snapshots'));
  const directory = fs.realpathSync(process.argv[1]);

  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('pi-desktop-diff-')) throw new Error('Invalid snapshot directory');
  const db = database.open(profile);
  db.close();
  fs.rmSync(directory, { recursive: true });
  database.removeSnapshotDirectory(directory);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
