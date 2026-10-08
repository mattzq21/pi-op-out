import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import solid from "vite-plugin-solid";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const modulesDirectory = existsSync(`${projectRoot}/node_modules`) ? realpathSync(`${projectRoot}/node_modules`) : undefined;

const sharedInstallations = modulesDirectory && /[\\/]npm-installations[\\/][a-f0-9]{64}[\\/]node_modules$/.test(modulesDirectory) ? dirname(dirname(modulesDirectory)) : undefined;

const dependencyCacheKey = createHash("sha256").update(modulesDirectory ?? `${projectRoot}/node_modules`).digest("hex").slice(0, 16);

const developmentBranch = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  cacheDir: `.trace/vite/${dependencyCacheKey}`,
  plugins: [solid()],
  define: { __PIOP_DEVELOPMENT_BRANCH__: JSON.stringify(developmentBranch), __PIOP_CUSTOM_DEVELOPMENT_LABEL__: false },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(projectRoot), ...(modulesDirectory ? [modulesDirectory] : []), ...(sharedInstallations ? [sharedInstallations] : [])],
    },
    watch: {
      ignored: ["**/target/**"]
    }
  }
});
