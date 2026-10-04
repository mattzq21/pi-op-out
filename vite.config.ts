import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import solid from "vite-plugin-solid";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const developmentBranch = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  cacheDir: ".trace/vite",
  plugins: [solid()],
  define: { __PIOP_DEVELOPMENT_BRANCH__: JSON.stringify(developmentBranch) },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(projectRoot), ...(existsSync(`${projectRoot}/node_modules`) ? [realpathSync(`${projectRoot}/node_modules`)] : [])],
    },
    watch: {
      ignored: ["**/src-tauri/target/**"]
    }
  }
});
