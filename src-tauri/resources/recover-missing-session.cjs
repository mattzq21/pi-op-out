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

if (request.action === 'inspect') {
  const registryRequest = { action: 'get', sessionId: header.id, root: path.join(require('node:os').homedir(), request.storage) };
  const saved = JSON.parse(execFileSync(process.execPath, ['-e', process.argv[3], JSON.stringify(registryRequest)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }));
  process.stdout.write(JSON.stringify({ canRecoverRemote: Boolean(saved?.remote_url && saved?.upstream_branch) }));
  process.exit(0);
}

let directory;

let container;

try {
  if (request.action === 'empty') directory = fs.mkdtempSync('/tmp/piop-session-');
  else if (request.action === 'remote') {
    const registryRequest = { action: 'get', sessionId: header.id, root: path.join(require('node:os').homedir(), request.storage) };
    const saved = JSON.parse(execFileSync(process.execPath, ['-e', process.argv[3], JSON.stringify(registryRequest)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }));
    let branch = request.branch?.trim() || saved?.upstream_branch || saved?.branch;

    if (!branch) {
      try { branch = JSON.parse(fs.readFileSync(path.join(path.dirname(header.cwd), 'parent.json'), 'utf8')).branch; } catch { }
    }

    let repository = request.repository?.trim() || saved?.remote_url;

    if (!repository) repository = header.checkpointRepositoryRoot || header.worktreeRestore?.repositoryRoot;

    if (!repository) {
      const entries = fs.readFileSync(request.sessionPath, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
      repository = entries.findLast((entry) => entry.data?.repositoryRoot)?.data.repositoryRoot;
    }

    const missingFields = [];

    if (!branch) missingFields.push('branch');

    if (!repository || (path.isAbsolute(repository) && !fs.existsSync(repository))) missingFields.push('repository');

    if (missingFields.length) { process.stdout.write(JSON.stringify({ missingFields })); process.exit(0); }

    git(['check-ref-format', '--branch', branch]);

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
