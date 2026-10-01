const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = JSON.parse(process.argv[1]);
const relocate = process.argv[2];
const header = JSON.parse(fs.readFileSync(request.sessionPath, 'utf8').split('\n').find((line) => line.trim()));
if (header.type !== 'session' || !path.isAbsolute(header.cwd ?? '')) throw new Error('Invalid session directory');
try { fs.lstatSync(header.cwd); throw new Error('The session directory exists again. Refresh the session list before opening it.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let directory;
let container;
try {
  if (request.action === 'empty') directory = fs.mkdtempSync('/tmp/piop-session-');
  else if (request.action === 'remote') {
    let branch = request.branch?.trim();
    if (!branch) {
      try { branch = JSON.parse(fs.readFileSync(path.join(path.dirname(header.cwd), 'parent.json'), 'utf8')).branch; } catch { }
    }
    if (!branch) throw new Error('Enter the branch to recover. This session has no saved branch name.');
    git(['check-ref-format', '--branch', branch]);
    let repository = request.repository?.trim();
    if (!repository) repository = header.checkpointRepositoryRoot || header.worktreeRestore?.repositoryRoot;
    if (!repository) {
      const entries = fs.readFileSync(request.sessionPath, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
      repository = entries.findLast((entry) => entry.data?.repositoryRoot)?.data.repositoryRoot;
    }
    if (!repository) throw new Error('Enter the remote repository URL or an existing local checkout.');
    if (fs.existsSync(repository)) repository = git(['-C', repository, 'remote', 'get-url', 'origin']);
    container = fs.mkdtempSync('/tmp/piop-recovery-');
    directory = path.join(container, 'workdir');
    git(['clone', '--single-branch', '--branch', branch, '--', repository, directory]);
  } else throw new Error('Unknown recovery action');
  execFileSync(process.execPath, ['-e', relocate, request.sessionPath, directory], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  process.stdout.write(JSON.stringify({ cwd: directory }));
} catch (error) {
  if (container) fs.rmSync(container, { recursive: true, force: true });
  else if (directory) fs.rmdirSync(directory);
  throw error;
}
