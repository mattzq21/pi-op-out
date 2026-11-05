const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');
const fs = require('node:fs');
const path = require('node:path');

const invalidate = onMainThread('transcript-metadata.invalidate', (file) => {
  let root;

  try { root = database.storageRoot(file); }
  catch { return; }

  database.forgetSessionFileMetadata(root, file);
});

const saveMetadata = onMainThread('transcript-metadata.saveMetadata', database.saveSessionFileMetadata);

function remember(file) {
  let root;

  try { root = database.storageRoot(file); }
  catch { return; }

  const metadata = savedFile(file);
  saveMetadata(root, file, String(metadata.mtimeNs), metadata.size);
}

function savedFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let metadata;

  try {
    metadata = fs.fstatSync(descriptor, { bigint: true });

    if (!metadata.isFile()) throw new Error('Saved transcript is not a regular file');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { fs.fsyncSync(parent); }
  finally { fs.closeSync(parent); }

  return metadata;
}

module.exports = { invalidate, remember };
