import { build } from "esbuild";

await build({
  entryPoints: ["src-tauri/resources/mcp-bridge.ts"],
  outfile: "src-tauri/resources/mcp-bridge.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
});
