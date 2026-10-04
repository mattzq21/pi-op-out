import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { cp } from "node:fs/promises";

export async function copyDependencies(source, destination) {
  if (process.platform === "linux") {
    const result = spawnSync("cp", ["-a", "--reflink=auto", "--", source, destination], { stdio: "inherit" });

    if (result.error?.code !== "ENOENT") {
      if (result.error) throw result.error;

      if (result.status !== 0) throw new Error("Could not copy shared npm dependencies");

      return;
    }
  }

  await cp(source, destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
}
