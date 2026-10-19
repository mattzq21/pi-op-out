import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { buildArtifact, buildBundle, buildInParallel, reportUnchanged } from "./incremental-build.mjs";
import { agentCommandInputs, agentCommandInventory } from "./agent-command-inventory.mjs";
import { storageSchemaImports } from "./storage-schema-plugin.mjs";

async function fastMode() {
  const license = await readFile("extensions/piop-openai-fast-mode/LICENSE", "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  await buildBundle({
    plugins: [storageSchemaImports()],
    entryPoints: ["extensions/piop-openai-fast-mode/src/index.ts"],
    outfile: "daemon/resources/fast-mode.bundle.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    banner: { js: `/*! piop-openai-fast-mode 0.3.0-piop.1.${license ? `\n${license}` : ""}*/` },
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
  }, "daemon/resources/fast-mode.bundle.mjs", { script: import.meta.url, inputs: ["scripts/storage-schema-plugin.mjs"] });
}

async function mcpBridge() {
  await buildInParallel([
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

async function backendScripts() {
  const commandInputs = await agentCommandInputs();

  await buildArtifact({
    output: "daemon/resources/agent-commands.json",
    inputs: [fileURLToPath(import.meta.url), fileURLToPath(new URL("./agent-command-inventory.mjs", import.meta.url)), ...commandInputs],
    key: "agent-command-inventory",
  }, async () => ({ content: `${JSON.stringify(await agentCommandInventory(commandInputs), null, 2)}\n` }));

  await buildBundle({
    entryPoints: ["daemon/resources/sdk-storage.mjs"],
    bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
    plugins: [storageSchemaImports()],
  }, "daemon/resources/sdk-storage.bundle.mjs", { script: import.meta.url, inputs: [fileURLToPath(new URL("./storage-schema-plugin.mjs", import.meta.url))] });
}

const { values } = parseArgs({ options: { only: { type: "string" } } });

const builders = { "fast-mode": fastMode, "mcp-bridge": mcpBridge, "backend-scripts": backendScripts };

if (values.only && !Object.hasOwn(builders, values.only)) throw new Error(`Unknown extension build: ${values.only}`);

await buildInParallel((values.only ? [builders[values.only]] : Object.values(builders)).map(build => build()));

reportUnchanged();
