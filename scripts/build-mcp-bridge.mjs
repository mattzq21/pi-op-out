import { buildBundle } from "./incremental-build.mjs";
import { gzipSync } from "node:zlib";

await buildBundle({
  entryPoints: ["src-tauri/resources/mcp-bridge.ts"],
  outfile: "src-tauri/resources/mcp-bridge.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
}, "src-tauri/resources/mcp-bridge.bundle.mjs", { script: import.meta.url });

await buildBundle({
  entryPoints: ["extensions/piop-define-agents/mcp-schema.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
}, "src-tauri/resources/mcp-schema.bundle.mjs", { script: import.meta.url, transform(content) {
  const payload = gzipSync(content, { level: 9 }).toString("base64");

  const source = `import { gunzipSync } from "node:zlib";\nconst { mcpServerSchema, mcpServersSchema } = await import("data:text/javascript;base64," + gunzipSync(Buffer.from("${payload}", "base64")).toString("base64"));\nexport { mcpServerSchema, mcpServersSchema };\n`;

  if (Buffer.byteLength(source) > 96 * 1024) throw new Error("MCP schema exceeds the embedded script argument budget");

  return source;
} });
