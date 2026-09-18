import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
const STATUS_KEY = "piop-session-cost";
const LIMIT_ENTRY = "piop-session-cost-limit";

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 100000;
}

async function loadLimit(): Promise<number | undefined> {
  let config: unknown;

  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (config && typeof config === "object" && (config as Record<string, unknown>).enabled === false) return undefined;

  const amount = config && typeof config === "object" ? (config as Record<string, unknown>).sessionCostLimit : undefined;
  if (!validAmount(amount)) {
    throw new Error(`${configPath}: sessionCostLimit must be between 0.01 and 100000`);
  }

  return amount;
}

function sessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
    const amount = (entry as { message?: { usage?: { cost?: { total?: unknown } } } }).message?.usage?.cost?.total;
    if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) total += amount;
  }
  return total;
}

const formatCost = (value: number) => `$${value.toFixed(2)}`;

export default async function sessionCostLimit(pi: ExtensionAPI) {
  const settings = () => { const request: { settings?: { sessionCostLimit: number; sessionCostLimitEnabled: boolean } } = {}; pi.events.emit("piop:runtime-settings", request); return request.settings; };
  const initial = settings();
  let limit = initial ? (initial.sessionCostLimitEnabled ? initial.sessionCostLimit : undefined) : await loadLimit();

  const restoreLimit = (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === LIMIT_ENTRY);
    if (entry?.type === "custom") {
      const saved = (entry.data as { limit?: unknown } | undefined)?.limit;
      if (saved !== null && !validAmount(saved)) throw new Error("Invalid saved session cost limit");
      limit = saved === null ? undefined : (saved as number);
    } else {
      const defaults = settings();
      if (defaults) limit = defaults.sessionCostLimitEnabled ? defaults.sessionCostLimit : undefined;
      pi.appendEntry(LIMIT_ENTRY, { limit: limit ?? null });
    }
  };

  const overLimit = (ctx: ExtensionContext) => limit !== undefined && sessionCost(ctx) >= limit;

  const publish = (ctx: ExtensionContext) => {
    if (limit === undefined) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const cost = sessionCost(ctx);
    ctx.ui.setStatus(STATUS_KEY, cost >= limit
      ? `Session cost limit reached (${formatCost(cost)} / ${formatCost(limit)})`
      : `Session ${formatCost(cost)} / ${formatCost(limit)}`);
  };

  pi.on("session_start", (_event, ctx) => {
    restoreLimit(ctx);
    publish(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreLimit(ctx);
    publish(ctx);
  });
  pi.on("message_end", (_event, ctx) => {
    publish(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    publish(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.text.startsWith("/")) return;
    if (!overLimit(ctx)) return;
    ctx.ui.notify(`Session cost limit of ${formatCost(limit!)} reached (API prices). Start a new conversation or raise the limit in Settings \u2192 General.`, "warning");
    return { action: "handled" };
  });

  pi.on("tool_call", (_event, ctx) => {
    if (!overLimit(ctx)) return;
    publish(ctx);
    return { block: true, terminate: true, reason: `Session cost limit of ${formatCost(limit!)} reached (API prices). Tool execution blocked.` };
  });
}
