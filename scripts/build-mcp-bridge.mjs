import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

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

const schema = await build({
  entryPoints: ["extensions/piop-define-agents/mcp-schema.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  write: false,
});

const payload = gzipSync(schema.outputFiles[0].contents, { level: 9 }).toString("base64");

const source = `import { gunzipSync } from "node:zlib";\nconst { mcpServerSchema, mcpServersSchema } = await import("data:text/javascript;base64," + gunzipSync(Buffer.from("${payload}", "base64")).toString("base64"));\nexport { mcpServerSchema, mcpServersSchema };\n`;

if (Buffer.byteLength(source) > 96 * 1024) throw new Error("MCP schema exceeds the embedded script argument budget");

await writeFile("src-tauri/resources/mcp-schema.bundle.mjs", source);
