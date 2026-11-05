import * as storageFs from "node:fs";
import * as storagePath from "node:path";

function storageSyncDirectory(path: string): void {
  const descriptor = storageFs.openSync(path, storageFs.constants.O_RDONLY | storageFs.constants.O_NOFOLLOW);

  try { storageFs.fsyncSync(descriptor); }
  finally { storageFs.closeSync(descriptor); }
}

function storageMetadata(path: string): storageFs.Stats | undefined {
  try { return storageFs.statSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function storageTarget(path: string): string {
  try { return storageFs.realpathSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  return path;
}

function storageWritePrepared(path: string, temporary: string, body: string): void {
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

function storagePublish(path: string, temporary: string, body: string, exclusive: boolean): void {
  try {
    storageWritePrepared(path, temporary, body);

    if (exclusive) storageFs.linkSync(temporary, path);
    else storageFs.renameSync(temporary, path);
    storageSyncDirectory(storagePath.dirname(path));
  } finally { storageFs.rmSync(temporary, { force: true }); }
}

export { storagePublish, storageTarget };
