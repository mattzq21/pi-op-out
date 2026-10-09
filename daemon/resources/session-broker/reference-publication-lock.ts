import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export async function acquireReferencePublicationLock() {
  const root = join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(join(root, "reference-publication.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid reference publication lock");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["--shared", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd] });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error("Could not lock reference publication")));
    });

    return file;
  } catch (error) { await file.close(); throw error; }
}
