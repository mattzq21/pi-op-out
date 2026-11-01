import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { parallelBuilds } from "./build-cache.mjs";
import { buildArtifact, buildBundle, reportUnchanged } from "./incremental-build.mjs";
import { storageSchemaImports } from "./storage-schema-plugin.mjs";

async function fastMode() {
  await buildBundle({
    plugins: [storageSchemaImports()],
    entryPoints: ["extensions/piop-openai-fast-mode/src/index.ts"],
    outfile: "daemon/resources/fast-mode.bundle.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    banner: { js: "/*! piop-openai-fast-mode 0.3.0-piop.1.*/" },
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
  }, "daemon/resources/fast-mode.bundle.mjs", { script: import.meta.url, inputs: ["scripts/storage-schema-plugin.mjs"] });
}

async function mcpBridge() {
  await parallelBuilds([
    buildBundle({
      entryPoints: ["daemon/resources/mcp-bridge.ts"],
      outfile: "daemon/resources/mcp-bridge.bundle.mjs",
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: true,
      legalComments: "none",
      external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
    }, "daemon/resources/mcp-bridge.bundle.mjs", { script: import.meta.url }),

    buildBundle({
      entryPoints: ["extensions/piop-define-agents/mcp-schema.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: true,
      legalComments: "none",
    }, "daemon/resources/mcp-schema.bundle.mjs", { script: import.meta.url, transform(content) {
      const payload = gzipSync(content, { level: 9 }).toString("base64");

      const source = `import { gunzipSync } from "node:zlib";\nconst { mcpServerSchema, mcpServersSchema } = await import("data:text/javascript;base64," + gunzipSync(Buffer.from("${payload}", "base64")).toString("base64"));\nexport { mcpServerSchema, mcpServersSchema };\n`;

      if (Buffer.byteLength(source) > 96 * 1024) throw new Error("MCP schema exceeds the embedded script argument budget");

      return source;
    } }),
  ]);
}

async function agentCommandInventory(files) {
  const names = new Set();

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerCommand") {
      const name = node.arguments[0];

      if (name && ts.isStringLiteral(name)) names.add(name.text);
    }

    ts.forEachChild(node, visit);
  }

  for (const path of files) visit(ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest));

  return [...names].sort();
}

async function backendScripts() {
  const commandInputs = [];

  for (const root of ["extensions", "daemon/resources"]) {
    for (const path of await readdir(root, { recursive: true })) {
      if (path.endsWith(".ts") && !path.includes("node_modules")) commandInputs.push(join(root, path));
    }
  }

  commandInputs.sort();

  await buildArtifact({
    output: "daemon/resources/agent-commands.json",
    inputs: [fileURLToPath(import.meta.url), ...commandInputs],
    key: "agent-command-inventory",
  }, async () => ({ content: `${JSON.stringify(await agentCommandInventory(commandInputs), null, 2)}\n` }));

  await buildBundle({
    entryPoints: ["daemon/resources/sdk-storage.mjs"],
    bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
    plugins: [storageSchemaImports()],
  }, "daemon/resources/sdk-storage.bundle.mjs", { script: import.meta.url, inputs: [fileURLToPath(new URL("./storage-schema-plugin.mjs", import.meta.url))] });
}

await parallelBuilds([fastMode(), mcpBridge(), backendScripts()]);

reportUnchanged();
