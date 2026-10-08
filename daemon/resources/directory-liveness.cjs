const fs = require('node:fs');
const path = require('node:path');

function metadata(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error; }
}

function readLink(file) {
  try { return fs.readlinkSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error; }
}

function inside(directory, file) { return file === directory || file?.startsWith(directory + path.sep); }

function processUses(directory, processDirectory) {
  if (inside(directory, readLink(path.join(processDirectory, 'cwd')))) return true;
  let descriptors;

  try { descriptors = fs.readdirSync(path.join(processDirectory, 'fd')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }

  return descriptors.some(descriptor => inside(directory, readLink(path.join(processDirectory, 'fd', descriptor))));
}

function directoryInUse(directory) {
  if (process.platform !== 'linux') return true;

  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const processDirectory = path.join('/proc', entry.name);
    const info = metadata(processDirectory);

    if (!info || info.uid !== BigInt(process.geteuid())) continue;

    if (processUses(directory, processDirectory)) return true;
  }

  return false;
}

module.exports = { directoryInUse };
