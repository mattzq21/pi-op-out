import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const license = await readFile("extensions/pi-openai-fast-mode-piop/LICENSE", "utf8");
await build({
  entryPoints: ["extensions/pi-openai-fast-mode-piop/src/index.ts"],
  outfile: "src-tauri/resources/fast-mode.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: { js: `/*! pi-openai-fast-mode-piop 0.3.0-piop.1.\n${license}*/` },
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
});
