const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function exists(file) {
  if (!file) return false;

  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function rename(source, destination) {
  fs.renameSync(source, destination);
  sync(path.dirname(destination));
  sync(path.dirname(source));
}

function git(common, args) {
  return execFileSync('git', ['-C', common, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], {
    encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3, 4],
  }).trim();
}

function sameContents(file, contents) { return !exists(file) || fs.readFileSync(file, 'utf8') === contents; }

function sidecarMoves(record) {
  return [
    [record.file.replace(/\.jsonl$/, '.snapshots'), record.destination.replace(/\.jsonl$/, '.snapshots')],
    [record.file.replace(/\.jsonl$/, '.diffs.json'), record.destination.replace(/\.jsonl$/, '.diffs.json')],
    [`${record.file}.loop-detection.json`, `${record.destination}.loop-detection.json`],
  ];
}

function checkRecord(record) {
  if (!exists(record.backup)) throw new Error(`Legacy archive backup is missing: ${record.backup}`);
  const original = fs.readFileSync(record.backup, 'utf8');
  const archived = record.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

  if (!sameContents(record.file, original) && !sameContents(record.file, archived)) throw new Error(`Legacy archive session changed: ${record.file}`);

  if (!sameContents(record.destination, archived)) throw new Error(`Legacy archived session changed: ${record.destination}`);

  for (const [source, destination] of sidecarMoves(record)) {
    if (exists(source) && exists(destination)) throw new Error(`Legacy archive has conflicting sidecars: ${source}`);
  }
}

function retirement(group) { return group.retiredPath ?? group.storedPath; }

function checkWorktree(group, directory) {
  const registration = fs.realpathSync(git(directory, ['rev-parse', '--absolute-git-dir']));

  if (registration !== group.own) throw new Error(`Legacy archived worktree changed: ${directory}`);
}

function checkGroup(group) {
  if (group.shared || !['git', 'directory'].includes(group.kind)) return;
  const stored = group.kind === 'git' ? group.storedPath : retirement(group);
  const sourceExists = exists(group.path);
  const storedExists = exists(stored);

  if (Boolean(sourceExists) === Boolean(storedExists)) throw new Error(`Legacy archive cannot safely restore its working directory: ${group.path}; recovery files retained`);

  if (group.kind === 'git') checkWorktree(group, sourceExists ? group.path : stored);
}

function restoreGroup(group) {
  if (group.shared || !['git', 'directory'].includes(group.kind)) return;
  const stored = group.kind === 'git' ? group.storedPath : retirement(group);

  if (exists(stored)) rename(stored, group.path);

  if (group.kind === 'git') {
    git(group.common, ['worktree', 'repair', group.path]);
    sync(group.own);
  }
}

function restoreRecord(record) {
  for (const [source, destination] of sidecarMoves(record)) {
    if (exists(destination)) rename(destination, source);
  }

  const original = fs.readFileSync(record.backup, 'utf8');

  if (!exists(record.file) || !sameContents(record.file, original)) {
    const temporary = `${record.backup}.${randomUUID()}.recover`;
    fs.copyFileSync(record.backup, temporary, fs.constants.COPYFILE_EXCL);
    sync(temporary);
    rename(temporary, record.file);
  }

  if (exists(record.destination)) { fs.unlinkSync(record.destination); sync(path.dirname(record.destination)); }
}

function releaseReferences(groups) {
  for (const group of groups) {
    for (const ref of group.refs ?? []) {
      let commit;

      try { commit = git(group.common, ['rev-parse', '--verify', ref]); }
      catch (error) { if (error.status === 128) continue; throw error; }

      if (commit !== group.commit) throw new Error(`Legacy archive reference changed: ${ref}`);
      git(group.common, ['update-ref', '-d', ref, commit]);
    }
  }
}

function retainDirectoryBackups(root, directory, groups) {
  for (const group of groups) {
    if (group.kind !== 'directory' || !group.preparedDirectory || !exists(group.storedPath)) continue;
    const storage = fs.realpathSync(path.join(root, 'archived-tmp'));
    const stored = fs.realpathSync(group.storedPath);

    if (path.dirname(stored) !== storage) throw new Error(`Legacy directory backup is outside archive storage: ${stored}`);
    const retained = path.join(directory, `retained-${path.basename(stored)}`);
    rename(stored, retained);
  }
}

function cleanup(directory) {
  for (const name of fs.readdirSync(directory)) {
    if (name !== 'recovery.json') fs.rmSync(path.join(directory, name), { recursive: true });
  }

  sync(directory);
  fs.unlinkSync(path.join(directory, 'recovery.json'));
  sync(directory);
  fs.rmdirSync(directory);
  sync(path.dirname(directory));
}

function complete(directory, transaction) {
  const temporary = path.join(directory, `${randomUUID()}.recovered`);
  fs.writeFileSync(temporary, JSON.stringify({ ...transaction, legacyRecovered: true }), { flag: 'wx', mode: 0o600 });
  sync(temporary);
  rename(temporary, path.join(directory, 'recovery.json'));
  cleanup(directory);
}

function recoverLegacy(root, directory, transaction) {
  if (transaction.legacyRecovered) return cleanup(directory);

  if (!Array.isArray(transaction.groups) || !Array.isArray(transaction.records)) throw new Error(`Invalid legacy archive journal: ${directory}`);

  for (const record of transaction.records) checkRecord(record);

  for (const group of transaction.groups) checkGroup(group);

  for (const group of [...transaction.groups].reverse()) restoreGroup(group);

  for (const record of [...transaction.records].reverse()) restoreRecord(record);
  releaseReferences(transaction.groups);
  retainDirectoryBackups(root, directory, transaction.groups);
  complete(directory, transaction);
}

module.exports = { recoverLegacy };
