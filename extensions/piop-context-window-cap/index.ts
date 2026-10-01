import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");

const CAP_ENTRY = "piop-session-context-cap";

async function loadCap(): Promise<number | undefined> {
  let config: unknown;

  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const values = config && typeof config === "object" ? config as Record<string, unknown> : {};

  if (values.enabled === false) return undefined;
  const cap = values.contextWindowCap;

  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`${configPath}: contextWindowCap must be a positive integer`);
  }

  return cap;
}

function savedCap(data: unknown) {
  const saved = (data as { cap?: unknown } | undefined)?.cap;

  if (saved !== null && (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 1000)) throw new Error("Invalid saved session context cap");

  return saved === null ? undefined : saved as number;
}

export default async function contextWindowCap(pi: ExtensionAPI) {
  const settings = () => { const request: { settings?: { contextWindowCap: number; contextWindowCapEnabled: boolean } } = {}; pi.events.emit("piop:runtime-settings", request);

  return request.settings; };

  const initial = settings();
  let cap = initial ? (initial.contextWindowCapEnabled ? initial.contextWindowCap : undefined) : await loadCap();
  const originalWindows = new Map<{ contextWindow: number }, number>();
  pi.on("input", (event, ctx) => {
    capModel(ctx.model);

    if (cap === undefined || event.text.startsWith("/")) return;
    const budgets = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings();
    const minimum = budgets.reserveTokens + budgets.keepRecentTokens + 1;

    if (cap >= minimum) return;
    const error = `This conversation's ${cap.toLocaleString()}-token context cap is too small for Pi's compaction budgets. Start a conversation with a cap of at least ${minimum.toLocaleString()} tokens, or reduce Pi's reserve and recent-history budgets.`;
    ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error }));
    ctx.ui.notify(error, "error");

    return { action: "handled" };
  });

  const capModel = (model: { contextWindow: number } | undefined) => {
    if (!model) return;

    if (!originalWindows.has(model)) originalWindows.set(model, model.contextWindow);
    const original = originalWindows.get(model)!;
    model.contextWindow = cap === undefined ? original : Math.min(original, cap);
  };

  const restoreCap = (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === CAP_ENTRY);

    if (entry?.type === "custom") {
      cap = savedCap(entry.data);
    } else {
      const defaults = settings();

      if (defaults) cap = defaults.contextWindowCapEnabled ? defaults.contextWindowCap : undefined;
      pi.appendEntry(CAP_ENTRY, { cap: cap ?? null });
    }

    for (const model of originalWindows.keys()) capModel(model);
    capModel(ctx.model);
  };

  pi.on("session_shutdown", () => { for (const [model, original] of originalWindows) model.contextWindow = original; });
  const unsubscribeModels = pi.events.on("piop:models-refreshed", (value) => { capModel((value as { ctx: ExtensionContext }).ctx.model); });
  pi.on("session_shutdown", () => { unsubscribeModels(); });

  pi.on("session_start", (_event, ctx) => {
    restoreCap(ctx);
  });
  pi.on("session_tree", (_event, ctx) => { restoreCap(ctx); });

  pi.on("model_select", (event) => {
    capModel(event.model);
  });

  pi.on("before_agent_start", (_event, ctx) => { capModel(ctx.model); });
}
