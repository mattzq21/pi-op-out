const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const { execFileSync } = require('node:child_process');

const git = (args, env = process.env) => execFileSync('git', args, { env, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

let snapshot;

try {
  let root;

  try { root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).toString().trim()); } catch { process.exit(3); }

  process.chdir(root);
  const paths = new Set(Buffer.concat([git(['ls-files', '-z', '-m', '-o', '--exclude-standard']), git(['diff', '--cached', '--name-only', '-z'])]).toString().split('\0').filter(Boolean));

  if (paths.size > 4096) process.exit(6);
  let total = 0;

  for (const file of paths) { let stat;

  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }

  total += stat.size;

  if (stat.size > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) process.exit(6); }

  const seed = git(['write-tree']).toString().trim();
  const repositoryObjects = fs.realpathSync(git(['rev-parse', '--git-path', 'objects']).toString().trim());
  const parent = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'git-snapshots'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  snapshot = fs.mkdtempSync(path.join(parent, 'pi-desktop-diff-')); fs.mkdirSync(path.join(snapshot, 'objects'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(snapshot, 'index'), GIT_OBJECT_DIRECTORY: path.join(snapshot, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects };
  git(['read-tree', seed], env); git(['add', '-A', '--', '.'], env);
  console.log(JSON.stringify({ root: snapshot, tree: git(['write-tree'], env).toString().trim(), repository_root: root }));
} catch (error) { if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true }); console.error(error.message); process.exitCode = 5; }
