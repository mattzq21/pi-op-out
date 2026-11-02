import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const localModules = join(root, "node_modules");

const stamp = join(root, ".trace-dependencies.json");

const installations = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "piop/bun-installations");

const bun = process.versions.bun ? process.execPath : "bun";

const inputs = ["package.json", "bun.lock", "bunfig.toml", ".npmrc"];

async function optional(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return undefined;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });

  if (result.error) throw result.error;

  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function protect(path, writable) {
  run("find", [path, "-type", "d", "-exec", "chmod", writable ? "u+w" : "a-w", "{}", "+"], root);
}

async function linkedTo(entry) {
  try { return (await readlink(localModules)) === join(entry, "node_modules"); } catch (error) {
    if (!["ENOENT", "EINVAL"].includes(error.code)) throw error;

    return false;
  }
}

async function populate(entry, files) {
  if (await optional(join(entry, "ready"))) return;
  console.log("Installing shared dependencies…");
  await mkdir(installations, { recursive: true });
  const temporary = join(installations, "install-" + randomUUID());
  await mkdir(temporary, { mode: 0o700 });

  try {
    for (const [name, content] of files) if (content) await writeFile(join(temporary, name), content);
    run(bun, ["install", "--frozen-lockfile"], temporary);
    await writeFile(join(temporary, "ready"), "ready");
    protect(temporary, false);

    try { await rename(temporary, entry); } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;

      if (!(await optional(join(entry, "ready")))) throw error;
    }
  } finally {
    if (await lstat(temporary).catch(() => undefined)) {
      protect(temporary, true);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function link(entry, key) {
  await mkdir(join(root, ".trace"), { recursive: true });
  const temporary = join(root, ".trace/dependencies-" + randomUUID());
  const backup = join(root, ".trace/dependencies-old-" + randomUUID());
  await symlink(join(entry, "node_modules"), temporary, "dir");

  try {
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
    await rm(temporary, { force: true });
  }
}

const files = await Promise.all(inputs.map(async name => [name, await optional(join(root, name))]));
const hash = createHash("sha256");

for (const [name, content] of files) hash.update(name).update("\0").update(content ?? "").update("\0");
const key = hash.update(JSON.stringify([process.versions.bun ?? process.version, process.platform, process.arch, process.env.NODE_ENV])).digest("hex");
const entry = join(installations, key);

if ((await optional(stamp))?.toString() !== key || !(await linkedTo(entry)) || !(await optional(join(entry, "ready")))) {
  await populate(entry, files);
  await link(entry, key);
}
