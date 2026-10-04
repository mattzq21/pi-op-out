import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const localModules = join(root, "node_modules");

const stamp = join(root, ".trace/dependencies.json");

const cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "piop/npm-installations");

function npm(args, cwd, quiet = false) {
  const cli = process.env.npm_execpath;
  const executable = cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

  const result = spawnSync(executable, cli ? [cli, ...args] : args, {
    cwd,
    stdio: quiet ? "pipe" : "inherit",
    shell: !cli && process.platform === "win32",
  });

  if (result.error) throw result.error;

  return result;
}

async function optional(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return undefined;
  }
}

async function localReady(key) {
  const saved = await optional(stamp);

  if (saved?.toString() !== key) return false;

  return npm(["ls", "--all"], root, true).status === 0;
}

function requiresLocalInstall(manifest, lock) {
  if (manifest.workspaces) return true;

  return Object.entries(lock.packages ?? {}).some(([path, entry]) => entry.link || (path && !path.startsWith("node_modules/")) || entry.resolved?.startsWith("file:"));
}

async function populate(entry, manifest, lock, npmrc) {
  if (await optional(join(entry, "ready"))) return;
  await mkdir(cacheRoot, { recursive: true });
  const temporary = join(cacheRoot, "install-" + randomUUID());
  await mkdir(temporary, { mode: 0o700 });

  try {
    await writeFile(join(temporary, "package.json"), manifest);
    await writeFile(join(temporary, "package-lock.json"), lock);

    if (npmrc) await writeFile(join(temporary, ".npmrc"), npmrc, { mode: 0o600 });
    const result = npm(["ci", "--prefer-offline", "--no-audit", "--no-fund", "--include=dev", "--include=optional"], temporary);

    if (result.status !== 0) throw new Error("Could not populate the shared npm installation");
    await rm(join(temporary, ".npmrc"), { force: true });
    await writeFile(join(temporary, "ready"), "ready");

    try { await rename(temporary, entry); } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;

      if (!(await optional(join(entry, "ready")))) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function materialize(entry, key) {
  const temporary = join(root, ".trace/dependencies-" + randomUUID());
  const backup = join(root, ".trace/dependencies-old-" + randomUUID());
  await mkdir(join(root, ".trace"), { recursive: true });

  try {
    await cp(join(entry, "node_modules"), temporary, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    let moved = false;

    try { await rename(localModules, backup); moved = true; } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try { await rename(temporary, localModules); } catch (error) {
      if (moved) await rename(backup, localModules);

      throw error;
    }

    await writeFile(stamp, key);
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const manifest = await readFile(join(root, "package.json"));

const lock = await readFile(join(root, "package-lock.json"));

const npmrc = await optional(join(root, ".npmrc"));

const packageJson = JSON.parse(manifest);

const lockJson = JSON.parse(lock);

if (requiresLocalInstall(packageJson, lockJson) || Object.keys(packageJson.scripts ?? {}).some(name => ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"].includes(name))) {
  await rm(stamp, { force: true });

  if (npm(["ls", "--all"], root, true).status !== 0) {
    const result = npm(["install", "--prefer-offline", "--no-audit", "--no-fund"], root);

    if (result.status !== 0) throw new Error("Could not install worktree dependencies");
  }
} else {
  const version = npm(["--version"], root, true);

  if (version.status !== 0) throw new Error("Could not determine the npm version");
  const hash = createHash("sha256").update(manifest).update(lock).update(npmrc ?? "");
  const userconfig = process.env.npm_config_userconfig || join(homedir(), ".npmrc");
  hash.update(await optional(userconfig) ?? "");
  const libc = process.report.getReport().header.glibcVersionRuntime ?? "non-glibc";
  const configuration = Object.entries(process.env).filter(([name]) => /^npm_config_/i.test(name) && !["npm_config_local_prefix", "npm_config_cache", "npm_config_user_agent"].includes(name.toLowerCase())).sort(([left], [right]) => left.localeCompare(right));
  const key = hash.update(JSON.stringify([process.version, process.platform, process.arch, libc, version.stdout.toString().trim(), process.env.NODE_ENV, configuration])).digest("hex");

  if (!(await localReady(key))) {
    const entry = join(cacheRoot, key);
    await populate(entry, manifest, lock, npmrc);
    await materialize(entry, key);
    console.log("Reused shared npm dependencies.");
  }
}
