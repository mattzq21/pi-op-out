const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const io = require('./session-transactions.cjs');

function writePrepared(file, contents) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);

  try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function config(plan, stage) {
  const source = execFileSync('git', ['-C', plan.source, 'rev-parse', '--path-format=absolute', '--git-path', 'config.worktree'], { encoding: 'utf8' }).trim();

  if (!io.exists(source)) return;
  const contents = fs.readFileSync(source, 'utf8');
  writePrepared(path.join(stage, 'config.worktree'), `${contents}\n[core]\n\tbare = false\n\tworktree = ${JSON.stringify(plan.target)}\n`);
}

function prepare(plan, save) {
  const directory = path.join(plan.common, 'piop-worktree-preparations');
  const stage = path.join(directory, plan.id);
  const registration = path.join(plan.common, 'worktrees', `piop-${plan.id}`);
  io.mkdir(directory);
  io.mkdir(path.dirname(registration));

  if (!plan.registration) {
    if (io.exists(registration)) throw new Error('Worktree registration already exists; retained');
    io.mkdir(stage);

    if (fs.readdirSync(stage).length) throw new Error('Unrecorded worktree registration preparation is not empty; retained');
    plan.registration = { path: registration, identity: io.identity(stage) };
    save();
  }

  if (plan.registration.path !== registration) throw new Error('Worktree registration path changed; retained');

  if (io.exists(registration)) {
    if (io.identity(registration) !== plan.registration.identity || io.exists(stage)) throw new Error('Worktree registration was replaced; retained');

    return registration;
  }

  if (io.identity(stage) !== plan.registration.identity) throw new Error('Worktree registration preparation changed; retained');
  writePrepared(path.join(stage, 'HEAD'), `ref: refs/heads/${plan.branch}\n`);
  writePrepared(path.join(stage, 'commondir'), `${plan.common}\n`);
  writePrepared(path.join(stage, 'gitdir'), `${path.join(plan.target, '.git')}\n`);
  writePrepared(path.join(stage, 'locked'), `piop-creation:${plan.id}\n`);
  config(plan, stage);
  io.syncTree(stage);
  fs.renameSync(stage, registration);
  io.sync(directory);
  io.sync(path.dirname(registration));

  return registration;
}

function create(plan, save) {
  const registration = prepare(plan, save);
  io.mkdir(plan.target);
  const pointer = path.join(plan.target, '.git');
  const body = `gitdir: ${registration}\n`;

  if (io.exists(pointer)) {
    if (!fs.lstatSync(pointer).isFile() || fs.readFileSync(pointer, 'utf8') !== body) throw new Error('Worktree pointer changed; retained');

    return;
  }

  const prepared = path.join(plan.container, 'copy-gitdir');
  writePrepared(prepared, body);
  fs.linkSync(prepared, pointer);
  io.sync(plan.target);
  io.sync(plan.container);
}

function unlock(plan) {
  const registration = plan.registration;

  if (!registration || io.identity(registration.path) !== registration.identity) throw new Error('Worktree registration changed; retained');
  const file = path.join(registration.path, 'locked');

  if (!io.exists(file)) return;

  if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8').trim() !== `piop-creation:${plan.id}`) throw new Error('Worktree lock belongs to another operation; retained');
  fs.unlinkSync(file);
  io.sync(registration.path);
}

module.exports = { create, unlock };
