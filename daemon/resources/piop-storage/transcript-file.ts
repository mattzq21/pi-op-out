import * as stateRecords from "./session-records.ts";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";

// Reads chat transcripts. Pi and the daemon both use it; it changes nothing.

export function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

// The saved entries of a transcript. A last line that a write did not finish is left out; `partial` gives its length.
export function readTranscript(path) {
  const body = storageFs.readFileSync(path);
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

  return { entries, end, partial: body.length - end };
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
