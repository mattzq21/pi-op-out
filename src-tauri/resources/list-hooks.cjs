const { readdir, stat } = require("node:fs/promises");
const { homedir } = require("node:os");
const { join, relative } = require("node:path");

async function inspect(path) {
  try { return await stat(path); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

(async () => {
  const directory = join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "hooks");
  const exists = Boolean(await inspect(directory));
  const hooks = [];
  if (exists) for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith(".") || name.endsWith(".d.ts")) continue;
    const path = join(directory, name);
    const info = await inspect(path);
    let entry;
    if (info?.isFile() && /\.(ts|js|mjs|cjs)$/.test(name)) entry = path;
    if (info?.isDirectory()) for (const filename of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
      const candidate = join(path, filename);
      if ((await inspect(candidate))?.isFile()) { entry = candidate; break; }
    }
    if (entry) hooks.push({ name, path: entry, entry: relative(directory, entry) });
  }
  process.stdout.write(JSON.stringify({ directory, exists, hooks }));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
