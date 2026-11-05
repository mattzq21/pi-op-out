import * as stateRecords from "./session-records.cjs";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";

// Reads chat transcripts. Pi and the daemon both use it; it changes nothing.

export function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

export function fileIdentity(info) {
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size) };
}

export function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.size === right?.size;
}

// The saved entries of a transcript. A last line that a write did not finish is left out; `partial` gives its length.
// With `strict`, the path must still name the file that was read.
export function readTranscript(path, { strict = false } = {}) {
  let descriptor;
  try { descriptor = storageFs.openSync(path, storageFs.constants.O_RDONLY | storageFs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT" && !strict) return { entries: [], identity: undefined, end: 0, partial: 0 }; throw error; }
  let body;
  let identity;

  try {
    const original = storageFs.fstatSync(descriptor, { bigint: true });
    if (!original.isFile()) throw new Error(`Session storage is not a regular file: ${path}`);
    body = storageFs.readFileSync(descriptor);
    if (strict) {
      const current = storageFs.lstatSync(path, { bigint: true });
      if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || BigInt(body.length) !== original.size) throw new Error(`The saved session changed unexpectedly: ${path}`);
    }
    identity = fileIdentity(original);
  } finally { storageFs.closeSync(descriptor); }
  const end = body.lastIndexOf(10) + 1;
  const lines = body.subarray(0, end).toString("utf8").split("\n");
  lines.pop();

  const entries = stateRecords.merge(path, lines.map((line, index) => {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.type !== "string") throw new Error("Invalid record");
      return entry;
    } catch { throw new Error(`Damaged chat record at line ${index + 1}: ${path}`); }
  }));

  return { entries, identity, end, partial: body.length - end };
}

export function storedSessionEntries(path) {
  const { entries, partial } = readTranscript(path);
  if (partial) console.warn(`${path}: last write was interrupted; ignored ${partial} bytes`);
  return entries;
}

export function sessionHeaderMatches(file, id, cwd) {
  let descriptor;

  try {
    descriptor = storageFs.openSync(file, storageFs.constants.O_RDONLY | storageFs.constants.O_NONBLOCK);

    if (!storageFs.fstatSync(descriptor).isFile()) return false;
    const buffer = Buffer.alloc(64 * 1024);
    const length = storageFs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]);

    return header.type === "session" && header.id === id && header.cwd?.constructor === String && header.cwd !== "" && storagePath.resolve(header.cwd) === storagePath.resolve(cwd);
  } catch { return false; }
  finally { if (descriptor !== undefined) storageFs.closeSync(descriptor); }
}
