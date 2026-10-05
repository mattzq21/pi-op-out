import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const hash = content => createHash("sha256").update(content).digest("hex");

async function fingerprint(path) {
  try {
    const info = await stat(path);

    if (!info.isDirectory()) return [path, hash(await readFile(path))];

    const entries = (await readdir(path)).sort();

    return [path, await Promise.all(entries.map(entry => fingerprint(join(path, entry))))];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    return [path, null];
  }
}

const fingerprints = paths => Promise.all([...new Set(paths)].sort().map(fingerprint));

const complete = entries => entries.every(([, content]) => content !== null && (!Array.isArray(content) || complete(content)));

async function readRecord(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;

    return undefined;
  }
}

export async function cachedBuild({ name, inputs, outputs, key }, generate) {
  const signature = hash(JSON.stringify([process.version, process.platform, process.arch, key, await fingerprints(inputs)]));

  const recordPath = join(root, ".trace/builds", hash(name) + ".json");

  const record = await readRecord(recordPath);

  const previousOutputs = record?.signature === signature ? await fingerprints(outputs) : undefined;

  if (previousOutputs && complete(previousOutputs) && JSON.stringify(previousOutputs) === JSON.stringify(record.outputs)) {
    console.log(`Unchanged: ${name}`);

    return;
  }

  await generate();

  const after = hash(JSON.stringify([process.version, process.platform, process.arch, key, await fingerprints(inputs)]));

  if (after !== signature) return;

  const current = { signature, outputs: await fingerprints(outputs) };

  if (!complete(current.outputs)) throw new Error(`Missing output from ${name}`);

  await mkdir(dirname(recordPath), { recursive: true });

  const temporary = `${recordPath}.${randomUUID()}.tmp`;

  await writeFile(temporary, JSON.stringify(current));
  await rename(temporary, recordPath);
}

export function runBuild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

export async function parallelBuilds(builds) {
  const results = await Promise.allSettled(builds);

  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);

  if (failures.length) throw new AggregateError(failures, "Build failed");
}
