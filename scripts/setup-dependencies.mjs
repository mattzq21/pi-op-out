import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const localModules = join(root, "node_modules");

const stamp = join(root, ".trace/dependencies.json");

const bun = process.versions.bun ? process.execPath : "bun";

async function optional(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return undefined;
  }
}

/** Returns true when node_modules is a real directory (not a link to the old shared npm installation). */
async function localModulesPresent() {
  try { return (await lstat(localModules)).isDirectory(); } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return false;
  }
}

/** Removes the link to the shared read-only npm installation that the npm version of this script made. */
async function detachSharedInstallation() {
  try {
    if ((await lstat(localModules)).isSymbolicLink()) await unlink(localModules);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const hash = createHash("sha256");

for (const name of ["package.json", "bun.lock", "bunfig.toml", ".npmrc"]) hash.update(name).update("\0").update((await optional(join(root, name))) ?? "").update("\0");
const key = hash.update(JSON.stringify([process.versions.bun ?? process.version, process.platform, process.arch, process.env.NODE_ENV])).digest("hex");

if ((await optional(stamp))?.toString() !== key || !(await localModulesPresent())) {
  await detachSharedInstallation();
  const result = spawnSync(bun, ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });

  if (result.error) throw result.error;

  if (result.status !== 0) throw new Error("Could not install dependencies");
  await mkdir(join(root, ".trace"), { recursive: true });
  await writeFile(stamp, key);
}
