import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");

async function loadCap(): Promise<number> {
  let config: unknown;

  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cap = config && typeof config === "object" ? (config as Record<string, unknown>).contextWindowCap : undefined;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`${configPath}: contextWindowCap must be a positive integer`);
  }

  return cap;
}

function capModel(model: Model<any> | undefined, cap: number): boolean {
  if (!model || model.contextWindow <= cap) return false;
  model.contextWindow = Math.min(model.contextWindow, cap);
  return true;
}

export default async function contextWindowCap(pi: ExtensionAPI) {
  const cap = await loadCap();

  pi.on("session_start", (_event, ctx) => {
    capModel(ctx.model, cap);
  });

  pi.on("model_select", (event) => {
    capModel(event.model, cap);
  });
}
