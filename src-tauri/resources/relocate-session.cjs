const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const [sessionPath, replacement] = process.argv.slice(1);
if (!fs.statSync(replacement).isDirectory()) throw new Error('Project directory does not exist');
const lines = fs.readFileSync(sessionPath, 'utf8').split('\n');
const header = JSON.parse(lines[0]);
if (header.type !== 'session') throw new Error('Invalid session header');
const git = (args) => execFileSync('git', ['-C', replacement, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
let root;
try { root = fs.realpathSync(git(['rev-parse', '--show-toplevel'])); } catch { /* Relocation also supports directories without Git. */ }
const verified = new Map();
if (root) {
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const entry = JSON.parse(lines[index]);
    const data = entry.data;
    if (entry.type !== 'custom' || entry.customType !== 'pi-project-files-watch-snapshot'
      || typeof data?.repositoryRoot !== 'string' || typeof data.ref !== 'string' || !data.ref.startsWith('refs/pi-session-snapshots/')
      || typeof data.commit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(data.commit)) continue;
    if (!verified.has(data.ref)) {
      try { verified.set(data.ref, git(['rev-parse', '--verify', data.ref])); }
      catch { verified.set(data.ref, undefined); }
    }
    if (verified.get(data.ref) === data.commit) {
      data.repositoryRoot = root;
      lines[index] = JSON.stringify(entry);
    }
  }
}
header.cwd = replacement;
lines[0] = JSON.stringify(header);
const temporary = `${sessionPath}.${randomUUID()}.tmp`;
let file;
try {
  const mode = fs.statSync(sessionPath).mode & 0o777;
  file = fs.openSync(temporary, 'wx', mode);
  fs.fchmodSync(file, mode);
  fs.writeFileSync(file, lines.join('\n'));
  fs.fsyncSync(file);
  fs.closeSync(file); file = undefined;
  fs.renameSync(temporary, sessionPath);
} finally {
  if (file !== undefined) fs.closeSync(file);
  fs.rmSync(temporary, { force: true });
}
