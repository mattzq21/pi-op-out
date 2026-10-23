import * as storageFs from "node:fs";
import * as storagePath from "node:path";

function storageSyncDirectory(path) {
  const descriptor = storageFs.openSync(path, storageFs.constants.O_RDONLY | storageFs.constants.O_NOFOLLOW);

  try { storageFs.fsyncSync(descriptor); }
  finally { storageFs.closeSync(descriptor); }
}

function storageMetadata(path) {
  try { return storageFs.statSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function storageTarget(path) {
  try { return storageFs.realpathSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  return path;
}

function storageWritePrepared(path, temporary, body) {
  const previous = storageMetadata(path);
  storageFs.rmSync(temporary, { force: true });
  const descriptor = storageFs.openSync(temporary, "wx", 0o600);

  try {
    storageFs.writeFileSync(descriptor, body, "utf8");

    if (previous) {
      const created = storageFs.fstatSync(descriptor);

      if (created.uid !== previous.uid || created.gid !== previous.gid) storageFs.fchownSync(descriptor, previous.uid, previous.gid);
      storageFs.fchmodSync(descriptor, previous.mode & 0o777);
    }

    storageFs.fsyncSync(descriptor);
  } finally { storageFs.closeSync(descriptor); }
}

function storagePublish(path, temporary, body, exclusive) {
  try {
    storageWritePrepared(path, temporary, body);

    if (exclusive) storageFs.linkSync(temporary, path);
    else storageFs.renameSync(temporary, path);
    storageSyncDirectory(storagePath.dirname(path));
  } finally { storageFs.rmSync(temporary, { force: true }); }
}

function requireStorageMethods(prototype, names) {
  if (names.some(name => !(prototype[name] instanceof Function))) throw new Error("This Pi SDK does not support Piop's storage protection. Update Piop before using this SDK.");
}

/** Replaces the file in one step, so a crash or a full disk cannot leave credentials or provider settings empty or partial. */
export { storagePublish, storageTarget, requireStorageMethods };
