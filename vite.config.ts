import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import solid from "vite-plugin-solid";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const modulesDirectory = existsSync(`${projectRoot}/node_modules`) ? realpathSync(`${projectRoot}/node_modules`) : undefined;

const sharedInstallations = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "piop/bun-installations");

const dependencyCacheKey = createHash("sha256").update(modulesDirectory ?? `${projectRoot}/node_modules`).digest("hex").slice(0, 16);

export default defineConfig({
  cacheDir: `.trace/vite/${dependencyCacheKey}`,
  plugins: [solid()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(projectRoot), sharedInstallations, ...(modulesDirectory ? [modulesDirectory] : [])],
    },
    watch: {
      ignored: ["**/target/**"]
    }
  }
});
