import { readFile } from "node:fs/promises";
import { buildBundle } from "./incremental-build.mjs";

const license = await readFile("extensions/piop-openai-fast-mode/LICENSE", "utf8");

await buildBundle({
  entryPoints: ["extensions/piop-openai-fast-mode/src/index.ts"],
  outfile: "src-tauri/resources/fast-mode.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: { js: `/*! piop-openai-fast-mode 0.3.0-piop.1.\n${license}*/` },
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
}, "src-tauri/resources/fast-mode.bundle.mjs", { script: import.meta.url });
