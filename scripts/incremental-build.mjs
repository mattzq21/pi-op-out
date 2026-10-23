import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

const cacheDirectory = ".trace/extension-builds";

const helper = fileURLToPath(import.meta.url);
let totalArtifacts = 0;
let unchangedArtifacts = 0;

export function reportUnchanged() {
  if (unchangedArtifacts) console.log(`Unchanged: ${unchangedArtifacts}/${totalArtifacts}`);
}

export async function buildInParallel(builds) {
  const results = await Promise.allSettled(builds);
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);

  if (failures.length) throw new AggregateError(failures, "Extension builds failed");
}

async function readOptional(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

const hash = content => createHash("sha256").update(content).digest("hex");

async function fingerprint(paths) {
  return Promise.all([...new Set(paths)].sort().map(async path => {
    const content = await readOptional(path);

    return [path, content === undefined ? null : hash(content)];
  }));
}

async function isCurrent(cachePath, signature, fixedInputs, output) {
  const saved = await readOptional(cachePath);
  let cached;

  try { cached = saved && JSON.parse(saved.toString()); } catch { }

  if (cached?.signature !== signature || !Array.isArray(cached.dependencies)) return false;

  const current = await fingerprint([...fixedInputs, ...cached.dependencies]);
  const outputContent = await readOptional(output);

  return JSON.stringify(current) === JSON.stringify(cached.inputs) && outputContent !== undefined && hash(outputContent) === cached.outputHash;
}

async function cachedDependencies(cachePath) {
  const saved = await readOptional(cachePath);

  try { const cached = saved && JSON.parse(saved.toString()); return Array.isArray(cached?.dependencies) ? cached.dependencies : []; } catch { return []; }
}

export async function buildArtifact({ output, inputs, key }, generate) {
  totalArtifacts += 1;
  const configuration = (await readdir(".")).filter(path => path === "package.json" || path === "bun.lock" || /^tsconfig.*\.json$/.test(path));
  const fixedInputs = [...inputs, helper, ...configuration];
  const signature = JSON.stringify([version, process.version, key, [...fixedInputs].sort()]);
  const cachePath = `${cacheDirectory}/${hash(output)}.json`;

  if (await isCurrent(cachePath, signature, fixedInputs, output)) {
    unchangedArtifacts += 1;

    return;
  }

  let knownDependencies = await cachedDependencies(cachePath);
  await rm(cachePath, { force: true });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = new Map(await fingerprint([...fixedInputs, ...knownDependencies]));
    const { content, dependencies = [] } = await generate();
    const after = await fingerprint([...fixedInputs, ...dependencies]);

    // A pass that discovers new dependencies cannot publish output; fingerprint them before retrying.
    if (after.some(([path, digest]) => !before.has(path) || before.get(path) !== digest)) {
      if (attempt === 3) throw new Error(`Inputs changed or new dependencies were found during 3 build attempts: ${output}`);

      knownDependencies = dependencies;
      console.warn(`Inputs changed or new dependencies were found; rebuilding: ${output}`);
      continue;
    }

    const outputContent = Buffer.from(content);
    const previous = await readOptional(output);

    if (!previous?.equals(outputContent)) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, outputContent);
    }

    const record = { signature, dependencies, inputs: after, outputHash: hash(outputContent) };
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record));
    await rename(temporary, cachePath);
    console.log(`Built: ${output}`);

    return;
  }
}

export async function buildBundle(options, output, { script, inputs = [], transform = content => content }) {
  await buildArtifact({ output, inputs: [fileURLToPath(script), ...inputs], key: options }, async () => {
    const result = await build({ ...options, write: false, metafile: true });

    return { content: await transform(result.outputFiles[0].contents), dependencies: Object.keys(result.metafile.inputs) };
  });
}
