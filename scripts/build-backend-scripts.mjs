import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const scripts = ["cleanup-ephemeral-session", "session-descendants", "archive-worktree", "restore-archived-worktree", "relocate-session", "index-sessions", "storage-inventory", "delete-session", "preserve-archive-checkpoints"];

await Promise.all(scripts.map(async name => {
  const result = await build({
    entryPoints: [`src-tauri/resources/${name}.cjs`],
    bundle: true,
    platform: "node",
    format: "iife",
    target: "node22",
    minify: true,
    write: false,
  });

  const payload = gzipSync(result.outputFiles[0].contents, { level: 9 }).toString("base64");
  const script = `eval(require("node:zlib").gunzipSync(Buffer.from("${payload}", "base64")).toString("utf8"));\n`;

  if (Buffer.byteLength(script) > 96 * 1024) throw new Error(`${name} exceeds the embedded script argument budget`);
  await writeFile(`src-tauri/resources/${name}.bundle.mjs`, script);
}));
