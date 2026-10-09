import { markCleanup } from "../session-database.cjs";

export { create as createWorktreeAllocation, cleanup as cleanupCheckpointContainer } from "../worktree-allocation.cjs";

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

export async function markWorktreeAllocation(storage: string) {
  markCleanup(dirname(storage), "worktree");
}

export async function acquireWorktreePublicationLock() {
  const root = join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(join(root, "reference-publication.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid reference publication lock");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["--shared", "3"], { stdio: ["ignore", "ignore", "pipe", file.fd] });
      let error = "";
      child.stderr?.on("data", (chunk: Buffer) => { error += chunk.toString(); });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(error.trim() || "Could not lock worktree creation"));
      });
    });

    return file;
  } catch (error) { await file.close(); throw error; }
}

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null) { super(message); }
}

export async function runGit(cwd: string, args: string[], env: Record<string, string> = {}, input?: string, owner?: number): Promise<string> {
  const deadline = Date.now() + 10_000;

  for (let attempt = 0; ; attempt += 1) {
    try { return await runGitOnce(cwd, args, env, input, owner); }
    catch (error) {
      const indexBusy = error instanceof GitError && error.exitCode === 128
        && /(?:^|\n)fatal: Unable to create '[^\n]*[\\/]index\.lock': File exists\./.test(error.message);

      const remaining = deadline - Date.now();

      if (!indexBusy || remaining <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 100 * 2 ** Math.min(attempt, 3))));
    }
  }
}

function runGitOnce(cwd: string, args: string[], env: Record<string, string> = {}, input?: string, owner?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe", ...(owner === undefined ? [] : [owner])] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTooLarge = false;

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;

      if (outputBytes > MAX_GIT_OUTPUT) { outputTooLarge = true; child.kill();

      return; }

      target.push(chunk);
    };

    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", (code) => {
      if (outputTooLarge) { reject(new GitError("Git output exceeded 4 MiB", code));

      return; }

      const out = Buffer.concat(stdout).toString("utf8");
      const error = Buffer.concat(stderr).toString("utf8").trim();

      if (code === 0) resolve(out);
      else reject(new GitError(error || `git ${args[0]} exited with code ${code}`, code));
    });
    child.stdin?.end(input);
  });
}
