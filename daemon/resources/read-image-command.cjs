const { closeSync, constants, fstatSync, openSync, readSync, realpathSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { homedir } = require('node:os');
const { hostScript } = require('./host-script.cjs');

const IMAGE_LIMIT = 10 * 1024 * 1024;
const STORAGE_DIRECTORY = process.env.PIOP_STORAGE_DIRECTORY || '.piop';
const GOAL_IMAGE_PATH = /^(?:sessions|archived)\/(?:[^/]+\/)*attachments\/goal-(?:[a-f0-9]{64}|[A-Za-z0-9]{6})\//;

hostScript(({ cwd, path }) => {
  if (typeof cwd !== 'string' || typeof path !== 'string') throw new Error('Invalid image request');
  const target = realpathSync(resolve(cwd, path));
  let root;
  try { root = realpathSync(cwd); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const location = root === undefined ? undefined : relative(root, target);
  if (location === undefined || location === '..' || location.startsWith('..' + sep) || isAbsolute(location)) {
    let storage;
    try { storage = realpathSync(join(homedir(), STORAGE_DIRECTORY)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!storage || !GOAL_IMAGE_PATH.test(relative(storage, target).split(sep).join('/'))) throw new Error('Image is outside the project');
  }
  let fd;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK); } catch (error) { throw new Error(`Could not read image: ${error.message}`); }
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (realpathSync('/proc/self/fd/' + fd) !== target) throw new Error('Image file changed while opening');
    if (!stats.isFile()) throw new Error('Select a regular image file');
    if (stats.size > IMAGE_LIMIT) throw new Error('Image is larger than 10 MB');
    const buffer = Buffer.alloc(IMAGE_LIMIT + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length >= buffer.length) break;
    }
    if (length > IMAGE_LIMIT) throw new Error('Image is larger than 10 MB');
    return buffer.subarray(0, length).toString('base64');
  } finally { closeSync(fd); }
});
