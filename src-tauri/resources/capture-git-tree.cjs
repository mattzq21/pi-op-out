const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const { execFileSync } = require('node:child_process');

const git = (args, env = process.env) => execFileSync('git', args, { env, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

let snapshot;

let pending;
const owner = process.argv[1] ? JSON.parse(process.argv[1]) : undefined;
function snapshotStorage() {
  if (!owner?.sessionPath) return undefined;
  const storage = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));
  const session = fs.realpathSync(owner.sessionPath);
  if (!['sessions', 'archived'].some((area) => session.startsWith(path.join(storage, area) + path.sep)) || !session.endsWith('.jsonl')) return undefined;
  const header = JSON.parse(fs.readFileSync(session, 'utf8').split('\n').find((line) => line.trim()));
  if (header.type !== 'session' || header.id !== owner.sessionId) throw new Error('Snapshot session identity changed');
  return session.replace(/\.jsonl$/, '.snapshots');
}
function retainSnapshot(token, env) {
  const retained = snapshotStorage();
  if (!retained) return;
  fs.mkdirSync(retained, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(retained) !== retained) throw new Error('Snapshot storage cannot be a symlink');
  pending = fs.mkdtempSync(path.join(retained, '.pending-'));
  fs.mkdirSync(path.join(pending, 'objects', 'pack'), { recursive: true });
  execFileSync('git', ['pack-objects', '--revs', path.join(pending, 'objects', 'pack', 'snapshot')], {
    env, input: `${token.tree}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  });
  fs.copyFileSync(path.join(snapshot, 'index'), path.join(pending, 'index'));
  fs.writeFileSync(path.join(pending, 'snapshot.json'), JSON.stringify({ ...owner, tree: token.tree, repositoryRoot: token.repository_root }), { flag: 'wx', mode: 0o600 });
  const latest = path.join(retained, 'latest');
  const previous = path.join(retained, 'previous');
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(latest)) fs.renameSync(latest, previous);
  try { fs.renameSync(pending, latest); }
  catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, latest); throw error; }
  pending = undefined;
  fs.rmSync(previous, { recursive: true, force: true });
}

try {
  let root;

  try { root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).toString().trim()); } catch { process.exit(3); }

  process.chdir(root);
  const retained = snapshotStorage();
  if (owner?.phase === 'start' && retained) {
    const latest = path.join(retained, 'latest');
    const previous = path.join(retained, 'previous');
    const baseline = fs.existsSync(latest) ? latest : fs.existsSync(previous) ? previous : undefined;
    if (baseline) {
      if (fs.realpathSync(baseline) !== baseline) throw new Error('Snapshot storage cannot be a symlink');
      const saved = JSON.parse(fs.readFileSync(path.join(baseline, 'snapshot.json'), 'utf8'));
      if (saved.sessionId !== owner.sessionId || !/^[a-f0-9]{40,64}$/.test(saved.tree)) throw new Error('Invalid saved comparison baseline');
      const parent = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'git-snapshots');
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      snapshot = fs.mkdtempSync(path.join(parent, 'pi-desktop-diff-'));
      fs.cpSync(baseline, snapshot, { recursive: true });
      console.log(JSON.stringify({ root: snapshot, tree: saved.tree, repository_root: root }));
      process.exit(0);
    }
  }
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
  const token = { root: snapshot, tree: git(['write-tree'], env).toString().trim(), repository_root: root };
  retainSnapshot(token, env);
  console.log(JSON.stringify(token));
} catch (error) { if (pending) fs.rmSync(pending, { recursive: true, force: true }); if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true }); console.error(error.message); process.exitCode = 5; }
