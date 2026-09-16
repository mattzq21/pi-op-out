import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const license = await readFile("extensions/piop-codex-compaction/upstream/LICENSE", "utf8");
await build({
  entryPoints: ["extensions/piop-codex-compaction/index.ts"],
  outfile: "src-tauri/resources/codex-compaction.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: { js: `/*! @ogulcancelik/pi-codex-compaction 0.1.5, with piop context integration.\n${license}*/` },
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
});
