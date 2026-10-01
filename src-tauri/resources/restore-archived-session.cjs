const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const source = fs.realpathSync(process.argv[1]);

const profile = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

const archiveRoot = fs.realpathSync(path.join(profile, 'archived'));

const relative = path.relative(archiveRoot, source);

if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(source) !== '.jsonl' || !fs.statSync(source).isFile()) throw new Error('Only archived conversations can be restored');

const sessions = path.join(profile, 'sessions');

fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });

const directory = fs.mkdtempSync(path.join(sessions, 'restored-'));

const target = path.join(directory, path.basename(source));

const diffSource = source.replace(/\.jsonl$/, '.diffs.json');

const diffTarget = target.replace(/\.jsonl$/, '.diffs.json');

let movedDiff = false;

try {
  if (fs.existsSync(diffSource)) {
    fs.renameSync(diffSource, diffTarget);
    movedDiff = true;
  }

  fs.renameSync(source, target);
} catch (error) {
  if (movedDiff) fs.renameSync(diffTarget, diffSource);
  fs.rmdirSync(directory);
  throw error;
}

process.stdout.write(target);
