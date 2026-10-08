import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { buildArtifact, buildBundle, buildInParallel } from "./incremental-build.mjs";
import { agentCommandInputs, agentCommandInventory } from "./agent-command-inventory.mjs";
import { storageSchemaImports } from "./storage-schema-plugin.mjs";

async function fastMode() {
  const license = await readFile("extensions/piop-openai-fast-mode/LICENSE", "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  await buildBundle({
    entryPoints: ["extensions/piop-openai-fast-mode/src/index.ts"],
    outfile: "crates/daemon/resources/fast-mode.bundle.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    banner: { js: `/*! piop-openai-fast-mode 0.3.0-piop.1.${license ? `\n${license}` : ""}*/` },
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
  }, "crates/daemon/resources/fast-mode.bundle.mjs", { script: import.meta.url });
}

async function mcpBridge() {
  await buildInParallel([
    buildBundle({
      entryPoints: ["crates/daemon/resources/mcp-bridge.ts"],
      outfile: "crates/daemon/resources/mcp-bridge.bundle.mjs",
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: true,
      legalComments: "none",
      external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
    }, "crates/daemon/resources/mcp-bridge.bundle.mjs", { script: import.meta.url }),

    buildBundle({
      entryPoints: ["extensions/piop-define-agents/mcp-schema.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: true,
      legalComments: "none",
    }, "crates/daemon/resources/mcp-schema.bundle.mjs", { script: import.meta.url, transform(content) {
      const payload = gzipSync(content, { level: 9 }).toString("base64");

      const source = `import { gunzipSync } from "node:zlib";\nconst { mcpServerSchema, mcpServersSchema } = await import("data:text/javascript;base64," + gunzipSync(Buffer.from("${payload}", "base64")).toString("base64"));\nexport { mcpServerSchema, mcpServersSchema };\n`;

      if (Buffer.byteLength(source) > 96 * 1024) throw new Error("MCP schema exceeds the embedded script argument budget");

      return source;
    } }),
  ]);
}

async function backendScripts() {
  const scripts = ["cleanup-ephemeral-session", "session-descendants", "archive-conversations", "archive-worktree", "restore-archived-worktree", "relocate-session", "index-sessions", "storage-inventory", "delete-session", "preserve-archive-checkpoints", "capture-git-diff", "publish-fork"];

  const commandInputs = await agentCommandInputs();

  await buildInParallel([
    ...scripts.map(async name => {
      await buildBundle({
        entryPoints: [`crates/daemon/resources/${name}.${name === "capture-git-diff" ? "ts" : "cjs"}`],
        bundle: true,
        platform: "node",
        format: "iife",
        target: "node22",
        minify: true,
        plugins: [storageSchemaImports()],
      }, `crates/daemon/resources/${name}.bundle.mjs`, { script: import.meta.url, inputs: [fileURLToPath(new URL("./storage-schema-plugin.mjs", import.meta.url))], transform(content) {
        const payload = brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).toString("base64");
        const script = `eval(require("node:zlib").brotliDecompressSync(Buffer.from("${payload}", "base64")).toString("utf8"));\n`;

        if (Buffer.byteLength(script) > 97 * 1024) throw new Error(`${name} exceeds the embedded script argument budget`);

        return script;
      } });
    }),

    buildBundle({
      entryPoints: ["extensions/piop-runtime-settings/provider-accounts.mjs"],
      bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
    }, "crates/daemon/resources/provider-accounts.bundle.mjs", { script: import.meta.url, transform(content) {
      const accountsPayload = gzipSync(content, { level: 9 }).toString("base64");
      const accountExports = "providerAccountsPath, readProviderAccounts, allocateProviderAccount, accountProvider, loadAccountProviders";
      const accountsModule = `import { gunzipSync as unpackProviderAccounts } from "node:zlib";\nconst { ${accountExports} } = await import("data:text/javascript;base64," + unpackProviderAccounts(Buffer.from("${accountsPayload}", "base64")).toString("base64"));\nexport { ${accountExports} };\n`;

      if (Buffer.byteLength(accountsModule) > 96 * 1024) throw new Error("Provider accounts exceeds the embedded script argument budget");

      return accountsModule;
    } }),

    buildArtifact({
      output: "crates/daemon/resources/agent-commands.json",
      inputs: [fileURLToPath(import.meta.url), fileURLToPath(new URL("./agent-command-inventory.mjs", import.meta.url)), ...commandInputs],
      key: "agent-command-inventory",
    }, async () => ({ content: `${JSON.stringify(await agentCommandInventory(commandInputs), null, 2)}\n` })),

    buildBundle({
      entryPoints: ["extensions/piop-define-agents/daemon-loader.ts"],
      bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
    }, "crates/daemon/resources/agent-definitions.bundle.mjs", { script: import.meta.url, transform(content) {
      const agentsPayload = gzipSync(content, { level: 9 }).toString("base64");

      return `import { gunzipSync } from "node:zlib";\ntry { await import("data:text/javascript;base64," + gunzipSync(Buffer.from("${agentsPayload}", "base64")).toString("base64")); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0); }\n`;
    } }),
  ]);
}

const { values } = parseArgs({ options: { only: { type: "string" } } });

const builders = { "fast-mode": fastMode, "mcp-bridge": mcpBridge, "backend-scripts": backendScripts };

if (values.only && !Object.hasOwn(builders, values.only)) throw new Error(`Unknown extension build: ${values.only}`);

await buildInParallel((values.only ? [builders[values.only]] : Object.values(builders)).map(build => build()));
