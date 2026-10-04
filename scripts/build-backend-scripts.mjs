import { fileURLToPath } from "node:url";
import { buildArtifact, buildBundle } from "./incremental-build.mjs";
import { gzipSync } from "node:zlib";
import { agentCommandInputs, agentCommandInventory } from "./agent-command-inventory.mjs";

const scripts = ["cleanup-ephemeral-session", "session-descendants", "archive-conversations", "archive-worktree", "restore-archived-worktree", "relocate-session", "index-sessions", "storage-inventory", "delete-session", "preserve-archive-checkpoints"];

await Promise.all(scripts.map(async name => {
  await buildBundle({
    entryPoints: [`src-tauri/resources/${name}.cjs`],
    bundle: true,
    platform: "node",
    format: "iife",
    target: "node22",
    minify: true,
  }, `src-tauri/resources/${name}.bundle.mjs`, { script: import.meta.url, transform(content) {
    const payload = gzipSync(content, { level: 9 }).toString("base64");
    const script = `eval(require("node:zlib").gunzipSync(Buffer.from("${payload}", "base64")).toString("utf8"));\n`;

    if (Buffer.byteLength(script) > 96 * 1024) throw new Error(`${name} exceeds the embedded script argument budget`);
    return script;
  } });
}));

await buildBundle({
  entryPoints: ["extensions/piop-runtime-settings/provider-accounts.mjs"],
  bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
}, "src-tauri/resources/provider-accounts.bundle.mjs", { script: import.meta.url, transform(content) {
  const accountsPayload = gzipSync(content, { level: 9 }).toString("base64");
  const accountExports = "providerAccountsPath, readProviderAccounts, allocateProviderAccount, accountProvider, loadAccountProviders";
  const accountsModule = `import { gunzipSync as unpackProviderAccounts } from "node:zlib";\nconst { ${accountExports} } = await import("data:text/javascript;base64," + unpackProviderAccounts(Buffer.from("${accountsPayload}", "base64")).toString("base64"));\nexport { ${accountExports} };\n`;

  if (Buffer.byteLength(accountsModule) > 96 * 1024) throw new Error("Provider accounts exceeds the embedded script argument budget");
  return accountsModule;
} });

const commandInputs = await agentCommandInputs();
await buildArtifact({
  output: "src-tauri/resources/agent-commands.json",
  inputs: [fileURLToPath(import.meta.url), fileURLToPath(new URL("./agent-command-inventory.mjs", import.meta.url)), ...commandInputs],
  key: "agent-command-inventory",
}, async () => ({ content: `${JSON.stringify(await agentCommandInventory(commandInputs), null, 2)}\n` }));

await buildBundle({
  entryPoints: ["extensions/piop-define-agents/daemon-loader.ts"],
  bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
}, "src-tauri/resources/agent-definitions.bundle.mjs", { script: import.meta.url, transform(content) {
  const agentsPayload = gzipSync(content, { level: 9 }).toString("base64");
  return `import { gunzipSync } from "node:zlib";\ntry { await import("data:text/javascript;base64," + gunzipSync(Buffer.from("${agentsPayload}", "base64")).toString("base64")); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0); }\n`;
} });
