import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const outfile = "src-tauri/resources/mcp-bridge.bundle.mjs";
const result = await build({
  entryPoints: ["src-tauri/resources/mcp-bridge.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
  write: false,
});

const output = result.outputFiles?.[0]?.contents;
if (!output) throw new Error("esbuild did not produce the MCP bridge bundle");

const current = await readFile(outfile).catch((error) => {
  if (error?.code === "ENOENT") return undefined;
  throw error;
});
if (!current || !current.equals(output)) await writeFile(outfile, output);
