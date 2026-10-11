import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import solid from "vite-plugin-solid";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const modulesDirectory = existsSync(`${projectRoot}/node_modules`) ? realpathSync(`${projectRoot}/node_modules`) : undefined;

const dependencyCacheKey = createHash("sha256").update(modulesDirectory ?? `${projectRoot}/node_modules`).digest("hex").slice(0, 16);

export default defineConfig({
  cacheDir: `.trace/vite/${dependencyCacheKey}`,
  plugins: [solid()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(projectRoot), ...(modulesDirectory ? [modulesDirectory] : [])],
    },
    watch: {
      ignored: ["**/target/**"]
    }
  }
});
