import { spawnSync } from "node:child_process";
import { join } from "node:path";

function accountHome() {
  const result = spawnSync("getent", ["passwd", String(process.getuid())], { encoding: "utf8" });

  if (result.error) throw result.error;

  const home = result.status === 0 ? result.stdout.split(":")[5] : undefined;

  if (!home) throw new Error(`getent passwd ${process.getuid()} did not return a home directory`);

  return home;
}

// Shared by all worktrees, also when a launcher gives the build a temporary HOME or XDG_CACHE_HOME.
export const sharedInstallations = join(accountHome(), ".cache/piop/bun-installations");
