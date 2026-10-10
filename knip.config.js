import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

const embeddedEntries = new Set();

for (const directory of ["daemon/src", "clients/desktop/src"]) {
  for (const file of await readdir(new URL(directory, import.meta.url), { recursive: true })) {
    const normalized = file.replaceAll("\\", "/");

    if (!normalized.endsWith(".rs")) continue;
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
    "daemon/resources/mcp-bridge.ts",
    "daemon/resources/{session-descendants,archive-conversations,restore-session,relocate-session,index-sessions,storage-inventory,delete-session}.cjs",
    "scripts/{build,oxlint-local}.mjs",
    "tools/oxlint/anti-slop/index.ts",
  ],
  project: [
    "*.{ts,mjs,js}",
    "clients/ui/**/*.{ts,tsx}",
    "extensions/**/*.{ts,mjs}",
    "daemon/resources/**/*.{ts,mjs,cjs}",
    "scripts/**/*.mjs",
    "tools/**/*.{ts,mjs}",
  ],
  ignore: [
    "**/*.bundle.mjs",
    "tools/oxlint/anti-slop/vendor/**",
  ],
  ignoreDependencies: [
    "@capacitor/android",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ],
  ignoreBinaries: ["flock", "rust-code-analysis-cli", "xwininfo"],
  paths: {
    "../session-broker.ts": ["daemon/resources/session-broker.ts"],
    "../session-broker/*": ["daemon/resources/session-broker/*"],
  },
};
