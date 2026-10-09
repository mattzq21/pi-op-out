import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

const embeddedEntries = new Set();

for (const directory of ["daemon/src", "clients/desktop/src"]) {
  for (const file of await readdir(new URL(directory, import.meta.url), { recursive: true })) {
    const normalized = file.replaceAll("\\", "/");

    if (!normalized.endsWith(".rs") || normalized.split("/").includes("tests") || /(?:^|\/)\w*tests?\.rs$/.test(normalized)) continue;
    const path = resolve(root, directory, file);
    const source = await readFile(path, "utf8");

    for (const match of source.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) {
      const entry = relative(root, resolve(dirname(path), match[1])).replaceAll("\\", "/");

      if (/\.(?:[cm]?js|tsx?)$/.test(entry) && !entry.endsWith(".bundle.mjs")) embeddedEntries.add(entry);
    }
  }
}

export default {
  entry: [
    "knip.config.js",
    "clients/ui/main.tsx",
    ...embeddedEntries,
    "extensions/piop-openai-fast-mode/src/index.ts",
    "extensions/piop-define-agents/{daemon-loader,mcp-schema}.ts",
    "extensions/piop-runtime-settings/provider-accounts.mjs",
    "daemon/resources/mcp-bridge.ts",
    "daemon/resources/{cleanup-ephemeral-session,session-descendants,archive-conversations,archive-worktree,restore-archived-worktree,relocate-session,index-sessions,storage-inventory,delete-session,preserve-archive-checkpoints,publish-fork,remove-worktree}.cjs",
    "scripts/{mutation-node-runner,oxlint-local}.mjs",
    "tools/oxlint/anti-slop/index.ts",
    "test/**/*.test.mjs",
    "test/e2e/**/*.spec.ts",
    "test/{chat-scroll-follow,chatgpt-recovery-proof,mobile-sidebar-scroll,mobile-terminal-scroll,terminal-cursor,register-typescript,mutation-coverage}.mjs",
    "test/fixtures/{chat-scroll-follow,desktop-terminal-cursor,mobile-terminal-scroll}.tsx",
    "test/isolated-node-home.mjs",
    "stryker.remaining.config.mjs",
  ],
  project: [
    "*.{ts,mjs,js}",
    "clients/ui/**/*.{ts,tsx}",
    "extensions/**/*.{ts,mjs}",
    "daemon/resources/**/*.{ts,mjs,cjs}",
    "scripts/**/*.mjs",
    "tools/**/*.{ts,mjs}",
    "test/**/*.{ts,tsx,mjs}",
  ],
  ignore: [
    "**/*.bundle.mjs",
    "tools/oxlint/anti-slop/vendor/**",
  ],
  ignoreDependencies: [
    "@capacitor/android",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@types/mocha",
    "@wdio/cli",
    "@wdio/local-runner",
    "@stryker-mutator/command-runner",
    "@stryker-mutator/piop-node-runner",
  ],
  ignoreBinaries: ["flock", "rust-code-analysis-cli", "xwininfo"],
  paths: {
    "../session-broker.ts": ["daemon/resources/session-broker.ts"],
    "../session-broker/*": ["daemon/resources/session-broker/*"],
  },
};
