import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hookStats from "./hook-stats.ts";

const hooksDirectory = join(homedir(), ".piop", "hooks");

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hookPaths(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(hooksDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const paths: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.endsWith(".d.ts")) continue;
    const path = join(hooksDirectory, name);
    const info = await stat(path);
    if (info.isFile() && /\.(ts|js|mjs|cjs)$/.test(name)) paths.push(path);
    if (info.isDirectory()) {
      for (const entry of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
        const candidate = join(path, entry);
        if (await isFile(candidate)) {
          paths.push(candidate);
          break;
        }
      }
    }
  }
  return paths;
}

export default async function piopHooks(pi: ExtensionAPI): Promise<void> {
  const hookApi = hookStats(pi);
  for (const path of await hookPaths()) {
    try {
      // Pi's TypeScript loader also handles these imports and Pi package aliases.
      const hook = await import(path);
      if (typeof hook.default !== "function") {
        throw new Error("Expected a default function export receiving the Pi extension API");
      }
      await hook.default(hookApi);
    } catch (error) {
      throw new Error(`Could not load hook ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
