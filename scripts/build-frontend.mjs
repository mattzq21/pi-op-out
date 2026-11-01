import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cachedBuild, parallelBuilds, runBuild } from "./build-cache.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({ options: { mode: { type: "string", default: "production" } } });

const mode = values.mode;

const outDir = mode === "mobile" ? "dist-mobile" : "dist";

async function frontend() {
  const { build, resolveConfig, version } = await import("vite");

  const configuration = { root, mode, build: { outDir } };

  const resolved = await resolveConfig(configuration, "build", "production", "production");

  const files = (await readdir(root)).filter(path => /^(package\.json|bun\.lock|tsconfig.*\.json|\.env(?:\..*)?|.*(postcss|tailwind).*|vite\.config\.(ts|js|mts|mjs|cts|cjs))$/.test(path));

  await cachedBuild({
    name: `Vite ${outDir}`,
    inputs: ["clients/ui", "daemon/plugins/review/review-prompt.txt", "extensions/piop-define-agents/mcp-schema.ts", "public", "index.html", "scripts/build-frontend.mjs", "scripts/build-cache.mjs", ...files, ...(resolved.configFileDependencies ?? [])],
    outputs: [outDir],
    key: [mode, version, resolved.env, process.env.NODE_ENV ?? "production", resolved.define],
  }, () => build(configuration));
}

await parallelBuilds([
  runBuild(process.execPath, ["node_modules/typescript/bin/tsc", "-b"]),
  frontend(),
]);
